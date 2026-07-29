from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.auth.webhook_token import hash_token
from gnt.config import get_settings
from gnt.db.models import WebhookToken
from gnt.db.org import ensure_org
from gnt.db.session import get_session
from gnt.rate_limit import check_rate_limit, enforce_webhook_ingest_ip_rate_limit
from gnt.routers.rules import CreateRuleRequest, _bare_id, create_draft_rule

# Generic webhook ingestion. Separate router from
# routers/rules.py on purpose, same reasoning as routers/github_webhook.py's
# own separate-router comment: no session/API-key auth (get_current_org) at
# all. The credential here is a per-org token embedded in the URL PATH,
# not a bearer header — Zapier/monday/HubSpot's own webhook config UIs
# typically take a plain URL and nothing else, so a header-based scheme
# would be real setup friction this feature exists to avoid. Resolving
# which org a request belongs to is exactly the "auth-bootstrap lookup"
# case webhook_tokens has no RLS for (see that model's own comment) — the
# org isn't known until the token itself is looked up, mirroring exactly
# how get_current_org resolves an mcp_api_keys row before scope_to_org.
router = APIRouter(prefix="/v1/webhooks", tags=["webhooks"])


@router.post("/ingest/{token}", status_code=201, dependencies=[Depends(enforce_webhook_ingest_ip_rate_limit)])
async def ingest_webhook(
    token: str,
    body: CreateRuleRequest,
    session: AsyncSession = Depends(get_session),
):
    """Turns a POST from Zapier (or anything else that can send a JSON
    webhook — monday.com and HubSpot both go through a Zapier "Webhooks by
    Zapier" step in the published recipe, see docs) into a draft rule,
    exactly as if a human had called POST /v1/rules by hand. Sanitize,
    tenant scoping, and the draft-rule shape are shared with that endpoint
    via create_draft_rule — this only adds a different front door onto it.

    The per-IP rate limit (enforce_webhook_ingest_ip_rate_limit) runs as a
    route-level dependency, ahead of everything below, specifically so a
    flood of requests with invalid/guessed tokens gets throttled before
    spending a token-hash lookup or a DB round trip on each one — same
    reasoning as checking it before, not after, resolving the token."""
    token_hash = hash_token(token)
    row = (
        await session.execute(select(WebhookToken).where(WebhookToken.token_hash == token_hash))
    ).scalar_one_or_none()
    if row is None or row.revoked_at is not None:
        # Same status/detail regardless of "no such token" vs "revoked" —
        # distinguishing the two to an unauthenticated caller would confirm
        # a guessed-but-revoked token was ever real.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid webhook token")

    limit = get_settings().webhook_ingest_rate_limit_per_hour
    if not await check_rate_limit("webhook_ingest_rate_limit", row.org_id, limit):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"rate limit exceeded ({limit}/hour per org)",
        )

    await ensure_org(session, row.org_id)
    row.last_used_at = datetime.now(timezone.utc)
    await session.commit()

    # The ONE call site that sets apply_privacy_gate=True.
    # This is the ambient-third-party-ingestion path the privacy gate
    # exists for (see gnt.pipeline.privacy_gate's module docstring): whatever a
    # Zapier/monday/HubSpot recipe forwards here was never something a
    # human on this device chose to expose to gnt, unlike a direct
    # POST /v1/rules call. create_draft_rule's own docstring covers the
    # rest of the reasoning (why this flag exists, why it's only set here,
    # and the permanent-masking tradeoff) in full — not repeated here.
    rule = await create_draft_rule(row.org_id, "webhook", body, apply_privacy_gate=True)
    return {"id": _bare_id(rule["slug"]), "status": rule["status"]}

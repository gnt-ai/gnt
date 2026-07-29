import json
import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.auth.better_auth import OrgContext, get_current_org, require_admin
from gnt.auth.mcp_keys import generate_key
from gnt.auth.webhook_token import generate_webhook_token
from gnt.config import get_settings
from gnt.db.models import McpApiKey, WebhookToken
from gnt.db.org import ensure_org
from gnt.db.session import get_session
from gnt.queue import get_pool
from gnt.rate_limit import enforce_cli_key_rate_limit, enforce_mcp_key_rate_limit

router = APIRouter(prefix="/v1", tags=["settings"])


@router.get("/whoami")
async def whoami(org: OrgContext = Depends(require_admin)):
    """Lets apps/web's CLI-facing org routes (app/api/cli/org/*) verify a
    cli-key and learn which org it's admin-scoped to, without duplicating
    key-hash/expiry/revocation logic over there — that's already exactly
    what require_admin resolves. No user_id in the response: a cli-key
    carries no real Better Auth identity of its own (see
    OrgContext.user_id's own comment), so apps/web resolves an acting
    admin from the org's own member list instead."""
    return {"org_id": org.org_id, "role": org.role}


_LOGIN_ID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
# 10 minutes -- comfortably inside gnt login's own 5-minute poll timeout
# (apps/cli/src/commands/login.ts), so a slow-but-still-in-time sign-in
# never has its delivered key evicted out from under the CLI's next poll.
_CLI_LOGIN_TTL_SECONDS = 600


class CreateKeyRequest(BaseModel):
    name: str | None = None
    # Set by /cli-login when gnt login minted this: stashes the freshly
    # minted key in Redis under this id so the CLI's poll endpoint below
    # can hand it back, instead of the browser posting it to a local
    # server on the CLI's own machine. See poll_cli_key's own docstring
    # for why that used to work and no longer reliably does.
    login_id: str | None = None


def _serialize_key(key: McpApiKey) -> dict:
    return {
        "id": str(key.id),
        "name": key.name,
        "key_type": key.key_type,
        "created_at": key.created_at.isoformat(),
        "last_used_at": key.last_used_at.isoformat() if key.last_used_at else None,
        "revoked_at": key.revoked_at.isoformat() if key.revoked_at else None,
        "expires_at": key.expires_at.isoformat() if key.expires_at else None,
    }


@router.post("/settings/cli-key", status_code=201)
async def create_cli_key(
    body: CreateKeyRequest | None = None,
    org: OrgContext = Depends(enforce_cli_key_rate_limit),
    session: AsyncSession = Depends(get_session),
):
    """Mints a personal credential for gnt login — deliberately separate
    from create_mcp_key below. This is the ONLY path that ever sets
    is_admin=True on a key, and require_session (wrapped inside
    enforce_cli_key_rate_limit) means it can only be called with a live
    session, never an existing API key, closing the self-escalation path
    (an API key minting another, more capable, API key). The rate limit
    on top of that is a separate backstop: a live session, compromised or
    scripted, shouldn't be able to mint unlimited admin-snapshotting keys.
    The key this returns still isn't meant to be handed to an agent — it
    carries the minting human's own admin status. Also stamps a default
    expires_at (cli_key_default_ttl_days, 90 days) — a live human logs
    back in well within that window, so this bounds
    how long a laptop-left-somewhere credential stays valid without
    anyone needing to remember to revoke it by hand."""
    await ensure_org(session, org.org_id)
    plaintext, key_hash = generate_key()
    key = McpApiKey(
        org_id=org.org_id,
        key_hash=key_hash,
        name=body.name if body else "cli",
        is_admin=org.is_admin,
        key_type="cli",
        expires_at=datetime.now(timezone.utc)
        + timedelta(days=get_settings().cli_key_default_ttl_days),
    )
    session.add(key)
    await session.commit()
    result = {"key": plaintext, **_serialize_key(key)}
    if body and body.login_id and _LOGIN_ID_PATTERN.match(body.login_id):
        await get_pool().set(
            f"cli_login:{body.login_id}",
            json.dumps({"key": plaintext, "key_id": result["id"]}),
            ex=_CLI_LOGIN_TTL_SECONDS,
        )
    return result


@router.get("/settings/cli-key/poll")
async def poll_cli_key(login_id: str):
    """Deliberately unauthenticated -- the CLI has no session or key yet at
    this point, that's the entire reason this endpoint exists. Security
    here rests on login_id's own unguessability (a random UUID minted
    fresh per `gnt login` run, ~120 bits of entropy) plus one-time
    consumption and a short TTL, same trust model RFC 8628's device
    authorization grant relies on -- and no weaker than what this replaced
    (a random ephemeral port on localhost was the previous flow's only
    protection). That flow POSTed the key straight to a plain HTTP server
    gnt login ran on 127.0.0.1: Chrome's Local Network Access policy now
    requires an explicit permission grant before a public https page can
    even reach a loopback address, which broke that delivery outright and
    isn't something a response header can opt back into. Polling this
    instead sidesteps browser loopback access entirely.
    """
    if not _LOGIN_ID_PATTERN.match(login_id):
        raise HTTPException(status_code=404, detail="not found")
    key = f"cli_login:{login_id}"
    pool = get_pool()
    raw = await pool.get(key)
    if raw is None:
        raise HTTPException(status_code=404, detail="not ready")
    await pool.delete(key)
    return json.loads(raw)


@router.post("/settings/mcp-keys", status_code=201)
async def create_mcp_key(
    body: CreateKeyRequest | None = None,
    org: OrgContext = Depends(enforce_mcp_key_rate_limit),
    session: AsyncSession = Depends(get_session),
):
    """No default expires_at, unlike create_cli_key above — that default
    TTL is scoped specifically to CLI keys. An
    MCP key is handed to an agent and left running unattended for however
    long that integration is meant to live; there's no human login cadence
    to bound it against the way a CLI key has one, and a silent expiry
    would just be a surprise outage for whatever's calling the MCP server.
    Revocation (already shipped) is the intended way to kill one of these
    early; expires_at just stays null here."""
    await ensure_org(session, org.org_id)
    plaintext, key_hash = generate_key()
    key = McpApiKey(org_id=org.org_id, key_hash=key_hash, name=body.name if body else None)
    session.add(key)
    await session.commit()
    # The plaintext is shown exactly once, here — only key_hash is ever
    # persisted, so this response is the only chance to see it again.
    return {"key": plaintext, **_serialize_key(key)}


@router.get("/settings/mcp-keys")
async def list_mcp_keys(
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(McpApiKey)
        .where(McpApiKey.org_id == org.org_id, McpApiKey.key_type == "mcp")
        .order_by(McpApiKey.created_at.desc())
    )
    return [_serialize_key(k) for k in result.scalars().all()]


@router.post("/settings/mcp-keys/{key_id}/revoke")
async def revoke_mcp_key(
    key_id: uuid.UUID,
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    key = await session.get(McpApiKey, key_id)
    if key is None or key.org_id != org.org_id or key.key_type != "mcp":
        raise HTTPException(status_code=404, detail="not found")
    if key.revoked_at is not None:
        raise HTTPException(status_code=400, detail="key is already revoked")
    key.revoked_at = datetime.now(timezone.utc)
    await session.commit()
    return _serialize_key(key)


@router.post("/settings/mcp-keys/{key_id}/rotate", status_code=201)
async def rotate_mcp_key(
    key_id: uuid.UUID,
    org: OrgContext = Depends(enforce_mcp_key_rate_limit),
    session: AsyncSession = Depends(get_session),
):
    """Mirrors rotate_cli_key, scoped to key_type == "mcp". Rate limited
    the same as create_mcp_key (rotation mints a new row, same abuse
    surface as minting outright) -- picked up in a rebase onto main after
    a sibling change added that limit after this branch had already
    forked from it; wired in here to close the gap rather than ship this
    PR without it. enforce_mcp_key_
    rate_limit wraps get_current_org, still the right AUTH gate on its
    own (not require_session, matching create_mcp_key and revoke_mcp_key
    above): an MCP key is never admin-capable regardless of who mints or
    rotates it, so there's no self-escalation path to close the way
    rotate_cli_key has to close one. No default expires_at on the
    replacement either, for the same reason create_mcp_key leaves it
    null."""
    old_key = await session.get(McpApiKey, key_id)
    if old_key is None or old_key.org_id != org.org_id or old_key.key_type != "mcp":
        raise HTTPException(status_code=404, detail="not found")
    if old_key.revoked_at is not None:
        raise HTTPException(status_code=400, detail="key is already revoked")
    plaintext, key_hash = generate_key()
    new_key = McpApiKey(org_id=org.org_id, key_hash=key_hash, name=old_key.name)
    session.add(new_key)
    await session.flush()
    old_key.revoked_at = datetime.now(timezone.utc)
    await session.commit()
    return {"key": plaintext, **_serialize_key(new_key)}


@router.get("/settings/cli-keys")
async def list_cli_keys(
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    """Mirrors list_mcp_keys, scoped to key_type == "cli" — lets an org see
    every personal CLI login credential minted under it (org.org_id filter
    is the only tenant boundary here: mcp_api_keys has no RLS policy of
    its own, see migration 0007's docstring, since resolving a bearer
    token to an org has to happen before the org is known)."""
    result = await session.execute(
        select(McpApiKey)
        .where(McpApiKey.org_id == org.org_id, McpApiKey.key_type == "cli")
        .order_by(McpApiKey.created_at.desc())
    )
    return [_serialize_key(k) for k in result.scalars().all()]


@router.post("/settings/cli-keys/{key_id}/revoke")
async def revoke_cli_key(
    key_id: uuid.UUID,
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    """Mirrors revoke_mcp_key exactly, scoped to key_type == "cli". Used by
    the settings UI/founder tooling to kill a specific CLI credential, and
    by `gnt logout` (with the key's own id, handed back at mint time and
    saved locally) to revoke itself server-side on the way out. Deliberately
    get_current_org, not require_session: revoking an existing key never
    mints anything new, so there's no self-escalation path to close the
    way create_cli_key has to close one — and `gnt logout` only ever has
    the plaintext key itself to authenticate with, never a live session."""
    key = await session.get(McpApiKey, key_id)
    if key is None or key.org_id != org.org_id or key.key_type != "cli":
        raise HTTPException(status_code=404, detail="not found")
    if key.revoked_at is not None:
        raise HTTPException(status_code=400, detail="key is already revoked")
    key.revoked_at = datetime.now(timezone.utc)
    await session.commit()
    return _serialize_key(key)


@router.post("/settings/cli-keys/{key_id}/rotate", status_code=201)
async def rotate_cli_key(
    key_id: uuid.UUID,
    org: OrgContext = Depends(enforce_cli_key_rate_limit),
    session: AsyncSession = Depends(get_session),
):
    """Mints a replacement CLI key, THEN revokes the
    one being rotated — in that order, so a failure between the two steps
    (e.g. the commit below never lands) leaves the caller with two valid
    keys rather than revoke-then-fail-to-create, which would lock them
    out. The new key inherits the old row's name/is_admin, and gets a
    fresh 90-day expires_at exactly like a brand new create_cli_key call.

    Gated the same way create_cli_key is (enforce_cli_key_rate_limit,
    which wraps require_session), not get_current_org like revoke_cli_key
    above — rotation mints a NEW key carrying the OLD row's is_admin
    snapshot, so this is a mint, not a revoke, and has the same
    self-escalation path require_session exists to close: an API key
    (even a non-admin one) must not be able to rotate an admin-capable
    CLI key in the same org into a plaintext it could then read."""
    old_key = await session.get(McpApiKey, key_id)
    if old_key is None or old_key.org_id != org.org_id or old_key.key_type != "cli":
        raise HTTPException(status_code=404, detail="not found")
    if old_key.revoked_at is not None:
        raise HTTPException(status_code=400, detail="key is already revoked")
    plaintext, key_hash = generate_key()
    new_key = McpApiKey(
        org_id=org.org_id,
        key_hash=key_hash,
        name=old_key.name,
        is_admin=old_key.is_admin,
        key_type="cli",
        expires_at=datetime.now(timezone.utc)
        + timedelta(days=get_settings().cli_key_default_ttl_days),
    )
    session.add(new_key)
    await session.flush()
    old_key.revoked_at = datetime.now(timezone.utc)
    await session.commit()
    return {"key": plaintext, **_serialize_key(new_key)}


def _serialize_webhook_token(token: WebhookToken) -> dict:
    return {
        "id": str(token.id),
        "name": token.name,
        "created_at": token.created_at.isoformat(),
        "last_used_at": token.last_used_at.isoformat() if token.last_used_at else None,
        "revoked_at": token.revoked_at.isoformat() if token.revoked_at else None,
    }


@router.post("/settings/webhook-tokens", status_code=201)
async def create_webhook_token(
    body: CreateKeyRequest | None = None,
    org: OrgContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    """Mints the credential a Zapier/monday/HubSpot
    webhook config posts to routers/webhooks.py's ingest endpoint with.
    require_admin (not require_session like create_cli_key): this token
    can only ever create draft rules, nothing McpApiKey-authenticated
    callers can't already do, so there's no privilege-escalation path to
    close the way an admin-snapshotting CLI key mint has to close one —
    an existing API key with admin standing is fine minting one of these."""
    await ensure_org(session, org.org_id)
    plaintext, token_hash = generate_webhook_token()
    token = WebhookToken(org_id=org.org_id, token_hash=token_hash, name=body.name if body else None)
    session.add(token)
    await session.commit()
    ingest_url = f"{get_settings().api_origin}/v1/webhooks/ingest/{plaintext}"
    # Shown exactly once, same as create_mcp_key/create_cli_key above —
    # only token_hash is ever persisted. ingest_url is the whole plaintext
    # token embedded in a ready-to-paste URL, since that's literally what
    # a Zapier/monday/HubSpot webhook config field wants, not a bare
    # token a human then has to hand-assemble into a URL themselves.
    return {"token": plaintext, "ingest_url": ingest_url, **_serialize_webhook_token(token)}


@router.get("/settings/webhook-tokens")
async def list_webhook_tokens(
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(WebhookToken).where(WebhookToken.org_id == org.org_id).order_by(WebhookToken.created_at.desc())
    )
    return [_serialize_webhook_token(t) for t in result.scalars().all()]


@router.post("/settings/webhook-tokens/{token_id}/revoke")
async def revoke_webhook_token(
    token_id: uuid.UUID,
    org: OrgContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    token = await session.get(WebhookToken, token_id)
    if token is None or token.org_id != org.org_id:
        raise HTTPException(status_code=404, detail="not found")
    if token.revoked_at is not None:
        raise HTTPException(status_code=400, detail="token is already revoked")
    token.revoked_at = datetime.now(timezone.utc)
    await session.commit()
    return _serialize_webhook_token(token)

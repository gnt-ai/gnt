"""Org offboarding: an admin-only,
confirmation-gated flow that exports an org's data and then permanently
deletes every org-scoped row in Postgres plus the org's rules mirror in
apps/store.

Two-step, not a single DELETE call — the blast radius (every rule, gap,
finding, ROI counter, key, and log this org has ever had) is large enough
that a single-call endpoint is one accidental click/curl away from
irreversible data loss:

  POST /v1/org/offboarding/request  -> real export bundle + a one-time
                                        confirmation token, good for 15
                                        minutes
  POST /v1/org/offboarding/confirm  -> deletes everything, but only with
                                        the exact token /request just
                                        issued for THIS org

Gated on require_admin_session, not require_admin alone — see that
dependency's own docstring in auth/better_auth.py for why an
admin-snapshotting API key isn't enough here.

The confirmation token lives in Redis (the same pool rate_limit.py already
uses), keyed per org, single-use (burned before the delete runs) and
TTL-bound — no new Postgres table needed for something this short-lived,
and it naturally expires without a cleanup job."""

import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.auth.better_auth import OrgContext, require_admin_session
from gnt.db.models import GithubConnection
from gnt.db.session import get_session
from gnt.github.app_auth import GithubAppError, uninstall_app
from gnt.org_offboarding import delete_org_postgres_data, export_org_data
from gnt.queue import get_pool
from gnt.store_client import StoreClientError, delete_org_source

router = APIRouter(prefix="/v1/org/offboarding", tags=["org-admin"])

# Long enough for an admin to actually read/save the export before
# confirming, short enough that a leaked or forgotten token doesn't stay a
# live "delete everything" credential indefinitely.
_CONFIRM_TTL_SECONDS = 15 * 60


def _redis_key(org_id: str) -> str:
    return f"org_offboard_confirm:{org_id}"


class ConfirmOffboardingRequest(BaseModel):
    confirmation_token: str = Field(min_length=1)


@router.post("/request")
async def request_offboarding(
    org: OrgContext = Depends(require_admin_session),
    session: AsyncSession = Depends(get_session),
):
    """Step 1 of 2. Produces the full export (rules with audit history,
    gaps, staleness, calibration/contradiction findings, ROI counters,
    onboarding events, key/connection metadata — never secrets) and mints
    a confirmation token scoped to this org. Calling this again before
    confirming just re-exports and overwrites the previous token (the old
    one stops working) — there is deliberately no limit on how many times
    an admin can re-request before actually confirming."""
    export = await export_org_data(session, org.org_id)

    token = secrets.token_urlsafe(32)
    await get_pool().set(_redis_key(org.org_id), token, ex=_CONFIRM_TTL_SECONDS)

    return {
        "export": export,
        "confirmation_token": token,
        "expires_in_seconds": _CONFIRM_TTL_SECONDS,
        "warning": (
            "This token authorizes permanently deleting every rule, gap, "
            "finding, ROI counter, key, and log this org has, plus its "
            "entire rules mirror. Save the export above — this cannot be "
            "undone. POST it to /v1/org/offboarding/confirm within "
            f"{_CONFIRM_TTL_SECONDS // 60} minutes to proceed."
        ),
    }


@router.post("/confirm")
async def confirm_offboarding(
    body: ConfirmOffboardingRequest,
    org: OrgContext = Depends(require_admin_session),
    session: AsyncSession = Depends(get_session),
):
    """Step 2 of 2 — irreversible. Requires the exact token /request just
    issued for THIS org (never another org's — the key is org-scoped, so a
    caller can never hold a valid token for anyone but their own org),
    unexpired, unused. Deletes apps/store's rules mirror first (the more
    likely-to-fail-partway network call), then every org-scoped Postgres
    row — see gnt.org_offboarding.delete_org_postgres_data for the full,
    authoritative table list."""
    key = _redis_key(org.org_id)
    pool = get_pool()
    stored = await pool.get(key)
    stored_token = stored.decode() if isinstance(stored, bytes) else stored
    if stored_token is None or not secrets.compare_digest(stored_token, body.confirmation_token):
        raise HTTPException(
            status_code=400,
            detail="missing, expired, or invalid confirmation token — call /request first",
        )
    # Single-use: burn the token before doing anything destructive so a
    # retried/duplicated confirm can't run the deletion twice.
    await pool.delete(key)

    # Uninstall the GitHub App from the customer's repo before the
    # connection row is deleted -- deleting github_connections is a
    # Postgres-only action with no effect on GitHub's own side, and
    # leaving the App installed would keep granting Contents/PR write
    # access to a repo this org no longer has any relationship with gnt
    # over. Best-effort: a PAT-connected org has no installation_id to
    # revoke, and a GitHub-side failure (App already removed from GitHub's
    # own UI, transient API error) must not block the rest of an
    # already-confirmed, irreversible offboarding request.
    connection = (
        await session.execute(select(GithubConnection).where(GithubConnection.org_id == org.org_id))
    ).scalar_one_or_none()
    if connection is not None and connection.installation_id is not None:
        try:
            await uninstall_app(connection.installation_id)
        except GithubAppError:
            pass

    try:
        store_result = await delete_org_source(org.org_id)
    except StoreClientError as exc:
        raise HTTPException(
            status_code=502, detail=f"could not delete the rules mirror: {exc}"
        ) from exc

    postgres_counts = await delete_org_postgres_data(session, org.org_id)
    await session.commit()

    return {"org_id": org.org_id, "store": store_result, "postgres": postgres_counts}

import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, SecretStr, field_validator
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.auth.better_auth import OrgContext, get_current_org, require_admin
from gnt.db.models import ZendeskConnection
from gnt.db.org import ensure_org
from gnt.db.session import get_session
from gnt.onboarding_metrics import log_onboarding_event
from gnt.zendesk.client import ZendeskClientError, verify_credentials
from gnt.zendesk.crypto import encrypt_token
from gnt.zendesk_sync_status import get_sync_status

router = APIRouter(prefix="/v1/settings/zendesk", tags=["zendesk"])

_SUBDOMAIN_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", re.IGNORECASE)


class ConnectZendeskRequest(BaseModel):
    subdomain: str
    agent_email: str
    api_token: SecretStr

    @field_validator("subdomain")
    @classmethod
    def validate_subdomain(cls, value: str) -> str:
        # Must be a bare DNS label -- no dots, slashes, or fragment/query
        # characters -- so it can't redirect _base_url's host interpolation
        # at an attacker-controlled host (e.g. cloud metadata via a value
        # like "169.254.169.254/x#").
        if not _SUBDOMAIN_RE.fullmatch(value.strip()):
            raise ValueError("subdomain must be a valid Zendesk subdomain (letters, numbers, hyphens only)")
        return value


def _serialize(connection: ZendeskConnection) -> dict:
    # Never the token, not even encrypted -- same convention
    # routers/github.py's connect_github response follows for its own PAT.
    return {"subdomain": connection.subdomain, "agent_email": connection.agent_email, "connected": True}


@router.post("", status_code=201)
async def connect_zendesk(
    body: ConnectZendeskRequest,
    org: OrgContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    """Live-validates the subdomain/email/token triple with one real read
    (verify_credentials) before anything is persisted -- same discipline
    routers/github.py's connect_github applies to a PAT via
    verify_repo_access, so a typo'd subdomain or a revoked token fails
    immediately with a clear error instead of silently saving a connection
    the nightly sync will only discover is broken hours later."""
    subdomain = body.subdomain.strip()
    agent_email = body.agent_email.strip()
    api_token = body.api_token.get_secret_value()
    try:
        await verify_credentials(subdomain, agent_email, api_token)
    except ZendeskClientError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    await ensure_org(session, org.org_id)
    stmt = (
        insert(ZendeskConnection)
        .values(
            org_id=org.org_id,
            subdomain=subdomain,
            agent_email=agent_email,
            api_token_encrypted=encrypt_token(api_token),
            installed_by_user_id=org.user_id,
        )
        .on_conflict_do_update(
            index_elements=["org_id"],
            set_={
                "subdomain": subdomain,
                "agent_email": agent_email,
                "api_token_encrypted": encrypt_token(api_token),
                "installed_by_user_id": org.user_id,
            },
        )
        .returning(ZendeskConnection)
    )
    result = await session.execute(stmt)
    await session.commit()
    connection = result.scalar_one()
    await log_onboarding_event(session, org.org_id, "zendesk_connected")
    return _serialize(connection)


@router.get("")
async def get_zendesk_connection(
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    connection = (
        await session.execute(select(ZendeskConnection).where(ZendeskConnection.org_id == org.org_id))
    ).scalar_one_or_none()
    if connection is None:
        return {"connected": False}
    return _serialize(connection)


@router.delete("", status_code=204)
async def disconnect_zendesk(
    org: OrgContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    connection = (
        await session.execute(select(ZendeskConnection).where(ZendeskConnection.org_id == org.org_id))
    ).scalar_one_or_none()
    if connection is None:
        raise HTTPException(status_code=404, detail="not connected")
    await session.delete(connection)
    await session.commit()


@router.get("/sync-status")
async def zendesk_sync_status(
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    """Sync-status health surface -- last
    successful sync, last error, and this run's item/candidate counts.
    `gnt status` shows connector health for CLI-local connectors already;
    this is the server-side equivalent's own surface, a plain GET a future
    `gnt status` addition or the web dashboard can poll rather than
    anything pushed. Returns the same "never synced yet" zero-value shape
    regardless of whether Zendesk is even connected -- callers that care
    should check GET /v1/settings/zendesk's `connected` field first."""
    return await get_sync_status(session, org.org_id)

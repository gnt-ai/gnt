from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, SecretStr
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.auth.better_auth import OrgContext, get_current_org, require_admin
from gnt.db.models import IntercomConnection
from gnt.db.org import ensure_org
from gnt.db.session import get_session
from gnt.intercom.client import IntercomClientError, verify_credentials
from gnt.intercom.crypto import encrypt_token
from gnt.intercom_sync_status import get_sync_status
from gnt.onboarding_metrics import log_onboarding_event

router = APIRouter(prefix="/v1/settings/intercom", tags=["intercom"])


class ConnectIntercomRequest(BaseModel):
    access_token: SecretStr


def _serialize(connection: IntercomConnection) -> dict:
    # Never the token, not even encrypted -- same convention
    # routers/zendesk.py's connect_zendesk response follows for its own
    # API token.
    return {"connected": True}


@router.post("", status_code=201)
async def connect_intercom(
    body: ConnectIntercomRequest,
    org: OrgContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    """Live-validates the access token with one real read
    (verify_credentials) before anything is persisted -- same discipline
    routers/zendesk.py's connect_zendesk applies to its own token via
    verify_credentials, so a typo'd or revoked token fails immediately
    with a clear error instead of silently saving a connection the
    nightly sync will only discover is broken hours later. Unlike
    connect_zendesk, there's no subdomain/agent_email to collect --
    Intercom's access token alone identifies the workspace (see
    gnt/intercom/client.py's module docstring)."""
    access_token = body.access_token.get_secret_value()
    try:
        await verify_credentials(access_token)
    except IntercomClientError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    await ensure_org(session, org.org_id)
    stmt = (
        insert(IntercomConnection)
        .values(
            org_id=org.org_id,
            access_token_encrypted=encrypt_token(access_token),
            installed_by_user_id=org.user_id,
        )
        .on_conflict_do_update(
            index_elements=["org_id"],
            set_={
                "access_token_encrypted": encrypt_token(access_token),
                "installed_by_user_id": org.user_id,
            },
        )
        .returning(IntercomConnection)
    )
    result = await session.execute(stmt)
    await session.commit()
    connection = result.scalar_one()
    await log_onboarding_event(session, org.org_id, "intercom_connected")
    return _serialize(connection)


@router.get("")
async def get_intercom_connection(
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    connection = (
        await session.execute(select(IntercomConnection).where(IntercomConnection.org_id == org.org_id))
    ).scalar_one_or_none()
    if connection is None:
        return {"connected": False}
    return _serialize(connection)


@router.delete("", status_code=204)
async def disconnect_intercom(
    org: OrgContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    connection = (
        await session.execute(select(IntercomConnection).where(IntercomConnection.org_id == org.org_id))
    ).scalar_one_or_none()
    if connection is None:
        raise HTTPException(status_code=404, detail="not connected")
    await session.delete(connection)
    await session.commit()


@router.get("/sync-status")
async def intercom_sync_status(
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    """Sync-status health surface -- last
    successful sync, last error, and this run's item/candidate counts.
    Same role as routers/zendesk.py's own /sync-status endpoint -- a
    plain GET a future `gnt status` addition or the web dashboard can
    poll rather than anything pushed. Returns the same "never synced yet"
    zero-value shape regardless of whether Intercom is even connected --
    callers that care should check GET /v1/settings/intercom's
    `connected` field first."""
    return await get_sync_status(session, org.org_id)

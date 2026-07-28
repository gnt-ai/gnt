from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.auth.better_auth import OrgContext, get_current_org, require_admin
from gnt.config import get_settings
from gnt.db.models import LinearConnection
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.db.session import get_session
from gnt.linear.crypto import decrypt_token, encrypt_token
from gnt.linear.oauth import LinearOAuthError, build_authorize_url, exchange_code, verify_state

router = APIRouter(prefix="/v1/linear", tags=["linear"])


def _plain_page(message: str) -> HTMLResponse:
    return HTMLResponse(
        f"<!doctype html><html><head><meta charset=\"utf-8\"><title>gnt.ai</title></head>"
        f"<body style=\"font-family: system-ui, sans-serif; padding: 3rem; text-align: center;\">"
        f"<p>{message}</p><p>You can close this tab.</p></body></html>"
    )


@router.get("/install-url")
async def install_url(
    org: OrgContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    await ensure_org(session, org.org_id)
    return {"url": build_authorize_url(org.org_id, org.user_id)}


@router.get("/oauth/callback")
async def oauth_callback(
    session: AsyncSession = Depends(get_session),
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
):
    if error or not code or not state:
        return _plain_page("Linear connection failed — go back to the dashboard and try again.")

    try:
        linear_state = verify_state(state)
        result = await exchange_code(code, linear_state.code_verifier)
    except LinearOAuthError:
        return _plain_page("Linear connection failed — go back to the dashboard and try again.")

    org_id = linear_state.org_id
    await scope_to_org(session, org_id)
    await ensure_org(session, org_id)
    encrypted_token = encrypt_token(result.access_token)
    stmt = (
        insert(LinearConnection)
        .values(org_id=org_id, access_token_encrypted=encrypted_token, installed_by_user_id=linear_state.user_id)
        .on_conflict_do_update(
            index_elements=["org_id"],
            set_={"access_token_encrypted": encrypted_token, "installed_by_user_id": linear_state.user_id},
        )
    )
    await session.execute(stmt)
    await session.commit()

    return RedirectResponse(f"{get_settings().web_origin}/app/settings/organization?linear=connected")


@router.get("/status")
async def status(
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    connection = (
        await session.execute(select(LinearConnection).where(LinearConnection.org_id == org.org_id))
    ).scalar_one_or_none()
    return {"connected": connection is not None}


@router.get("/token")
async def token(
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    """See routers/notion.py's own token endpoint docstring — identical
    CLI-fetches-its-own-org's-token shape, used by
    apps/cli/src/prebrain/mcp-linear.ts."""
    connection = (
        await session.execute(select(LinearConnection).where(LinearConnection.org_id == org.org_id))
    ).scalar_one_or_none()
    if connection is None:
        raise HTTPException(status_code=404, detail="Linear isn't connected for this org yet.")
    return {"access_token": decrypt_token(connection.access_token_encrypted)}

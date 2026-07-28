from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.auth.better_auth import OrgContext, get_current_org, require_admin
from gnt.config import get_settings
from gnt.db.models import NotionConnection
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.db.session import get_session
from gnt.notion.crypto import decrypt_token, encrypt_token
from gnt.notion.oauth import NotionOAuthError, build_authorize_url, exchange_code, verify_state

router = APIRouter(prefix="/v1/notion", tags=["notion"])


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
    return {"url": build_authorize_url(org.org_id)}


@router.get("/oauth/callback")
async def oauth_callback(
    session: AsyncSession = Depends(get_session),
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
):
    if error or not code or not state:
        return _plain_page("Notion connection failed — go back to the dashboard and try again.")

    try:
        notion_state = verify_state(state)
        result = await exchange_code(code)
    except NotionOAuthError:
        return _plain_page("Notion connection failed — go back to the dashboard and try again.")

    org_id = notion_state.org_id
    await scope_to_org(session, org_id)
    await ensure_org(session, org_id)
    encrypted_token = encrypt_token(result.access_token)
    stmt = (
        insert(NotionConnection)
        .values(
            org_id=org_id,
            access_token_encrypted=encrypted_token,
            workspace_id=result.workspace_id,
            workspace_name=result.workspace_name,
            bot_id=result.bot_id,
            installed_by_user_id=result.owner_user_id or "unknown",
        )
        .on_conflict_do_update(
            index_elements=["org_id"],
            set_={
                "access_token_encrypted": encrypted_token,
                "workspace_id": result.workspace_id,
                "workspace_name": result.workspace_name,
                "bot_id": result.bot_id,
                "installed_by_user_id": result.owner_user_id or "unknown",
            },
        )
    )
    await session.execute(stmt)
    await session.commit()

    return RedirectResponse(f"{get_settings().web_origin}/app/settings/organization?notion=connected")


@router.get("/status")
async def status(
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    connection = (
        await session.execute(select(NotionConnection).where(NotionConnection.org_id == org.org_id))
    ).scalar_one_or_none()
    if connection is None:
        return {"connected": False}
    return {"connected": True, "workspace_name": connection.workspace_name}


@router.get("/token")
async def token(
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    """The CLI-facing half of this connector: `gnt prebrain --mcp-notion`
    fetches its own org's token from here (same Bearer-API-key auth every
    other CLI-to-API call already uses, see apps/cli/src/credentials.ts)
    instead of a customer pasting one — the CLI still does the actual
    read/parse/chunk/privacy-gate work locally with whatever token comes
    back, unchanged from before this connector existed."""
    connection = (
        await session.execute(select(NotionConnection).where(NotionConnection.org_id == org.org_id))
    ).scalar_one_or_none()
    if connection is None:
        raise HTTPException(status_code=404, detail="Notion isn't connected for this org yet.")
    return {"access_token": decrypt_token(connection.access_token_encrypted)}

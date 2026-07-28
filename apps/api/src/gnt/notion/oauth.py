import secrets
import time
from dataclasses import dataclass

import httpx
import jwt

from gnt.config import get_settings

# Notion's hosted MCP server's own OAuth surface (mcp.notion.com), not the
# classic api.notion.com/v1/oauth surface public integrations historically
# used — this API's client id/secret came from that server's own dynamic
# client registration endpoint (mcp.notion.com/register, confirmed live),
# so its authorize/token endpoints are the ones to use, not the legacy
# integration ones.
_AUTHORIZE_URL = "https://mcp.notion.com/authorize"
_TOKEN_URL = "https://mcp.notion.com/token"
_STATE_TTL_SECONDS = 60 * 10


class NotionOAuthError(Exception):
    pass


@dataclass(frozen=True)
class NotionOAuthResult:
    access_token: str
    workspace_id: str | None
    workspace_name: str | None
    bot_id: str | None
    owner_user_id: str | None


@dataclass(frozen=True)
class NotionState:
    org_id: str


def _redirect_uri() -> str:
    return f"{get_settings().api_origin}/v1/notion/oauth/callback"


def build_authorize_url(org_id: str) -> str:
    settings = get_settings()
    now = int(time.time())
    state = jwt.encode(
        {"org_id": org_id, "nonce": secrets.token_urlsafe(8), "iat": now, "exp": now + _STATE_TTL_SECONDS},
        settings.notion_state_secret,
        algorithm="HS256",
    )
    params = httpx.QueryParams(
        {
            "response_type": "code",
            "client_id": settings.notion_client_id,
            "redirect_uri": _redirect_uri(),
            "state": state,
        }
    )
    return f"{_AUTHORIZE_URL}?{params}"


def verify_state(state: str) -> NotionState:
    """Returns the org_id encoded in a state token minted by
    build_authorize_url, or raises NotionOAuthError if it's missing,
    expired, or tampered with."""
    try:
        claims = jwt.decode(state, get_settings().notion_state_secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise NotionOAuthError("invalid or expired state") from exc

    org_id = claims.get("org_id")
    if not org_id:
        raise NotionOAuthError("state missing org_id")
    return NotionState(org_id=org_id)


async def exchange_code(code: str) -> NotionOAuthResult:
    settings = get_settings()
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(
            _TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": _redirect_uri(),
                "client_id": settings.notion_client_id,
                "client_secret": settings.notion_client_secret,
            },
        )
    body = response.json()
    access_token = body.get("access_token")
    if not response.is_success or not access_token:
        raise NotionOAuthError(body.get("error_description") or body.get("error") or "notion oauth exchange failed")

    owner = body.get("owner") or {}
    owner_user = owner.get("user") or {}
    return NotionOAuthResult(
        access_token=access_token,
        workspace_id=body.get("workspace_id"),
        workspace_name=body.get("workspace_name"),
        bot_id=body.get("bot_id"),
        owner_user_id=owner_user.get("id"),
    )

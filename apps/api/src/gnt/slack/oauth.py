import secrets
import time
from dataclasses import dataclass

import httpx
import jwt

from gnt.config import get_settings

_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize"
_ACCESS_URL = "https://slack.com/api/oauth.v2.access"
# Just the slash command itself now — chat:write and im:write were for
# proactively posting messages (chat.postMessage/conversations.open, see
# slack/client.py), which nothing does anymore since the weekly gap-digest
# DM and freeform /brain capture were both retired. The slash command's own
# response (routers/slack.py's slash_command) is just its JSON response
# body, no separate Web API call, so it needs no scope beyond this.
_SCOPES = "commands"
_STATE_TTL_SECONDS = 60 * 10


class SlackOAuthError(Exception):
    pass


@dataclass(frozen=True)
class SlackOAuthResult:
    team_id: str
    team_name: str
    bot_user_id: str
    bot_token: str
    scope: str
    authed_user_id: str


@dataclass(frozen=True)
class SlackState:
    org_id: str
    origin: str  # "web" | "cli" — which finish page the callback should redirect to


def _redirect_uri() -> str:
    return f"{get_settings().api_origin}/v1/slack/oauth/callback"


def build_authorize_url(org_id: str, origin: str = "web") -> str:
    settings = get_settings()
    now = int(time.time())
    state = jwt.encode(
        {
            "org_id": org_id,
            "origin": origin,
            "nonce": secrets.token_urlsafe(8),
            "iat": now,
            "exp": now + _STATE_TTL_SECONDS,
        },
        settings.slack_state_secret,
        algorithm="HS256",
    )
    params = httpx.QueryParams(
        {
            "client_id": settings.slack_client_id,
            "scope": _SCOPES,
            "redirect_uri": _redirect_uri(),
            "state": state,
        }
    )
    return f"{_AUTHORIZE_URL}?{params}"


def verify_state(state: str) -> SlackState:
    """Returns the org_id/origin encoded in a state token minted by
    build_authorize_url, or raises SlackOAuthError if it's missing, expired,
    or tampered with."""
    try:
        claims = jwt.decode(state, get_settings().slack_state_secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise SlackOAuthError("invalid or expired state") from exc

    org_id = claims.get("org_id")
    if not org_id:
        raise SlackOAuthError("state missing org_id")
    return SlackState(org_id=org_id, origin=claims.get("origin", "web"))


async def exchange_code(code: str) -> SlackOAuthResult:
    settings = get_settings()
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(
            _ACCESS_URL,
            data={
                "client_id": settings.slack_client_id,
                "client_secret": settings.slack_client_secret,
                "code": code,
                "redirect_uri": _redirect_uri(),
            },
        )
    body = response.json()
    if not body.get("ok"):
        raise SlackOAuthError(body.get("error", "slack oauth exchange failed"))

    team = body.get("team") or {}
    authed_user = body.get("authed_user") or {}
    return SlackOAuthResult(
        team_id=team.get("id", ""),
        team_name=team.get("name", ""),
        bot_user_id=body.get("bot_user_id", ""),
        bot_token=body.get("access_token", ""),
        scope=body.get("scope", ""),
        authed_user_id=authed_user.get("id", ""),
    )

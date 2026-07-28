import base64
import hashlib
import secrets
import time
from dataclasses import dataclass

import httpx
import jwt

from gnt.config import get_settings

_AUTHORIZE_URL = "https://linear.app/oauth/authorize"
_TOKEN_URL = "https://api.linear.app/oauth/token"
_SCOPE = "read"
_STATE_TTL_SECONDS = 60 * 10


class LinearOAuthError(Exception):
    pass


@dataclass(frozen=True)
class LinearOAuthResult:
    access_token: str


@dataclass(frozen=True)
class LinearState:
    org_id: str
    user_id: str
    code_verifier: str


def _redirect_uri() -> str:
    return f"{get_settings().api_origin}/v1/linear/oauth/callback"


def _pkce_pair() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode("ascii")
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    return verifier, challenge


def build_authorize_url(org_id: str, user_id: str) -> str:
    """PKCE only, no client_secret — same tradeoff
    connect-linear-mcp.ts's own doc comment documents for the CLI's
    loopback flow against this identical app: Linear's PKCE support makes
    client_secret optional, and a server-held secret buys nothing PKCE
    doesn't already cover for a confidential backend either. The verifier
    travels inside the signed state token (not the authorize URL) so it
    survives the redirect round trip without needing a server-side session
    to stash it in — its confidentiality doesn't matter (only an attacker
    who also has the authorization code could use it), only that it's
    unguessable and tamper-evident, which the JWT signature already gives."""
    settings = get_settings()
    now = int(time.time())
    code_verifier, code_challenge = _pkce_pair()
    state = jwt.encode(
        {
            "org_id": org_id,
            "user_id": user_id,
            "code_verifier": code_verifier,
            "nonce": secrets.token_urlsafe(8),
            "iat": now,
            "exp": now + _STATE_TTL_SECONDS,
        },
        settings.linear_state_secret,
        algorithm="HS256",
    )
    params = httpx.QueryParams(
        {
            "response_type": "code",
            "client_id": settings.linear_client_id,
            "redirect_uri": _redirect_uri(),
            "scope": _SCOPE,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
    )
    return f"{_AUTHORIZE_URL}?{params}"


def verify_state(state: str) -> LinearState:
    """Returns the org_id/code_verifier encoded in a state token minted by
    build_authorize_url, or raises LinearOAuthError if it's missing,
    expired, or tampered with."""
    try:
        claims = jwt.decode(state, get_settings().linear_state_secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise LinearOAuthError("invalid or expired state") from exc

    org_id = claims.get("org_id")
    user_id = claims.get("user_id")
    code_verifier = claims.get("code_verifier")
    if not org_id or not user_id or not code_verifier:
        raise LinearOAuthError("state missing org_id, user_id, or code_verifier")
    return LinearState(org_id=org_id, user_id=user_id, code_verifier=code_verifier)


async def exchange_code(code: str, code_verifier: str) -> LinearOAuthResult:
    settings = get_settings()
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(
            _TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": _redirect_uri(),
                "client_id": settings.linear_client_id,
                "code_verifier": code_verifier,
            },
        )
    body = response.json()
    access_token = body.get("access_token")
    if not response.is_success or not access_token:
        raise LinearOAuthError(body.get("error_description") or body.get("error") or "linear oauth exchange failed")
    return LinearOAuthResult(access_token=access_token)

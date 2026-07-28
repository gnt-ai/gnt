"""GitHub App auth — mints a short-lived App JWT (RS256, signed with
GITHUB_APP_PRIVATE_KEY) and exchanges it for a per-installation access
token, on demand, per operation. Nothing here is ever persisted: an App
JWT is good for ~9 minutes, an installation access token for ~1 hour —
gnt/github/crypto.py's Fernet discipline is for what DOES get persisted
(the PAT flow's own long-lived token), not this one.

Also owns the install flow's signed state token (org_id + who started
it), reusing the App's own RSA keypair via RS256 instead of provisioning
a dedicated HS256 state secret the way gnt/slack/oauth.py's
build_authorize_url/verify_state do for Slack — no new secret to add
config.py for this, since the same private key already exists for JWT
minting. Same shape otherwise: a short-TTL, nonce-bearing, signed token
that's the only thing standing between "GitHub redirected here" and
"this is genuinely the org that started this install".
"""

import secrets
import time
from dataclasses import dataclass

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
from cryptography.hazmat.primitives.serialization import load_pem_private_key

from gnt.config import get_settings
from gnt.db.models import GithubConnection
from gnt.github.crypto import decrypt_token

_API_BASE = "https://api.github.com"
_ACCEPT = "application/vnd.github+json"
_JWT_TTL_SECONDS = 9 * 60  # GitHub's own cap is 10 minutes
_JWT_CLOCK_SKEW_SECONDS = 60  # GitHub's docs recommend backdating iat this far
_STATE_TTL_SECONDS = 10 * 60


class GithubAppError(Exception):
    pass


def _require_configured() -> None:
    settings = get_settings()
    if not settings.github_app_id or not settings.github_app_private_key:
        raise GithubAppError(
            "the GitHub App isn't configured on this deploy (GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY unset) "
            "-- use `gnt connect github --pat` instead"
        )


def _private_key() -> RSAPrivateKey:
    _require_configured()
    pem = get_settings().github_app_private_key.encode("utf-8")
    key = load_pem_private_key(pem, password=None)
    if not isinstance(key, RSAPrivateKey):
        raise GithubAppError("GITHUB_APP_PRIVATE_KEY is not an RSA private key")
    return key


def _app_jwt() -> str:
    settings = get_settings()
    now = int(time.time())
    return jwt.encode(
        {"iat": now - _JWT_CLOCK_SKEW_SECONDS, "exp": now + _JWT_TTL_SECONDS, "iss": settings.github_app_id},
        _private_key(),
        algorithm="RS256",
    )


def _app_headers() -> dict:
    return {"Authorization": f"Bearer {_app_jwt()}", "Accept": _ACCEPT}


async def _call(method: str, url: str, headers: dict, action: str, **kwargs) -> httpx.Response:
    """Same shape as gnt/github/client.py's own _call — one place every
    App-auth GitHub call routes through, so httpx.HTTPError (DNS failure,
    timeout, connection refused) always becomes a GithubAppError instead
    of an uncaught exception, and tests only need to monkeypatch this one
    function rather than httpx itself."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            return await client.request(method, url, headers=headers, **kwargs)
    except httpx.HTTPError as exc:
        raise GithubAppError(f"could not reach GitHub to {action}: {exc}") from exc


async def get_installation_token(installation_id: int) -> str:
    """Exchanges the App JWT for a short-lived (~1hr) installation access
    token scoped to exactly this installation's repos/permissions. Minted
    fresh on every call -- never cached, never persisted -- so every
    operation this backs (reading a merged file, opening a PR) uses a
    token that's only ever alive for the length of that one request.
    ponytail: no caching across calls within the same request even when a
    caller needs several -- add an in-request cache if minting starts
    showing up as real latency, not before."""
    response = await _call(
        "POST",
        f"{_API_BASE}/app/installations/{installation_id}/access_tokens",
        _app_headers(),
        "mint an installation token",
    )
    if response.status_code != 201:
        raise GithubAppError(
            f"could not mint an installation token for installation {installation_id} "
            f"({response.status_code}): {response.text[:200]}"
        )
    token = response.json().get("token")
    if not isinstance(token, str) or not token:
        raise GithubAppError("GitHub did not return an installation token")
    return token


async def get_repo_token(connection: GithubConnection) -> str:
    """The one place the App-vs-PAT branch lives for every call site that
    needs a token to act against a connected repo -- a freshly minted,
    never-persisted installation token for an App-connected org
    (installation_id set), or the connection's own encrypted PAT for an
    org still on the legacy flow. Every caller that used to reach for
    `decrypt_token(connection.pat_encrypted)` directly goes through this
    instead, so this is the single point that has to know the difference."""
    if connection.installation_id is not None:
        return await get_installation_token(connection.installation_id)
    return decrypt_token(connection.pat_encrypted)


async def get_app_slug() -> str:
    """The App's own public slug (e.g. "gnt-ai-connector"), fetched live
    off GET /app rather than hardcoded -- avoids baking a guessed slug
    into code when the founder registered the real one directly in
    GitHub's UI. ponytail: no caching -- install-url is a click-once path
    (one call per connect attempt, not per request), add an lru_cache if
    that stops being true."""
    response = await _call("GET", f"{_API_BASE}/app", _app_headers(), "look up the app")
    if response.status_code != 200:
        raise GithubAppError(f"could not look up the GitHub App ({response.status_code}): {response.text[:200]}")
    slug = response.json().get("slug")
    if not isinstance(slug, str) or not slug:
        raise GithubAppError("GitHub did not return an app slug")
    return slug


async def list_installation_repos(installation_id: int) -> list[dict]:
    """The repo(s) the customer picked during install -- GitHub only tells
    you this after the fact, via the installation's own token (not the App
    JWT). Called right after the install callback to learn repo_url/
    default_branch for the connection this org just created."""
    token = await get_installation_token(installation_id)
    response = await _call(
        "GET",
        f"{_API_BASE}/installation/repositories",
        {"Authorization": f"Bearer {token}", "Accept": _ACCEPT},
        "list installation repos",
    )
    if response.status_code != 200:
        raise GithubAppError(
            f"could not list installation repos ({response.status_code}): {response.text[:200]}"
        )
    repos = response.json().get("repositories")
    if not isinstance(repos, list):
        raise GithubAppError("GitHub did not return an installation repository list")
    return repos


async def uninstall_app(installation_id: int) -> None:
    """Revokes the App's access to this installation entirely — called on
    org offboarding (routers/org_admin.py) so a customer's repo doesn't
    keep granting Contents/PR write access to gnt after they've deleted
    their account. Uses the App JWT, not an installation token — revoking
    your own installation grant is an App-level operation, not something
    an installation token can do to itself. A 404 (already uninstalled,
    e.g. the customer removed it from GitHub's own UI first) is treated as
    success, same convention as client.py's close_pull_request."""
    response = await _call(
        "DELETE",
        f"{_API_BASE}/app/installations/{installation_id}",
        _app_headers(),
        f"uninstall installation {installation_id}",
    )
    if response.status_code not in (204, 404):
        raise GithubAppError(
            f"could not uninstall installation {installation_id} ({response.status_code}): {response.text[:200]}"
        )


@dataclass(frozen=True)
class InstallState:
    org_id: str
    user_id: str
    origin: str  # "web" | "cli" — which finish page the callback should point at


def build_install_state(org_id: str, user_id: str, origin: str = "web") -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "org_id": org_id,
            "user_id": user_id,
            "origin": origin,
            "nonce": secrets.token_urlsafe(8),
            "iat": now,
            "exp": now + _STATE_TTL_SECONDS,
        },
        _private_key(),
        algorithm="RS256",
    )


def verify_install_state(state: str) -> InstallState:
    """Returns the org_id/user_id/origin encoded in a state token minted by
    build_install_state, or raises GithubAppError if it's missing,
    expired, or tampered with. This IS the callback's authorization check
    — GitHub's redirect carries no session of its own, so a valid,
    unexpired signature here is what proves "the org this installation_id
    gets attached to is genuinely the one that started this install",
    not e.g. whatever org happens to be active in the browser completing
    it."""
    try:
        claims = jwt.decode(state, _private_key().public_key(), algorithms=["RS256"])
    except jwt.PyJWTError as exc:
        raise GithubAppError("invalid or expired state") from exc
    org_id = claims.get("org_id")
    user_id = claims.get("user_id")
    if not org_id or not user_id:
        raise GithubAppError("state missing org_id/user_id")
    return InstallState(org_id=org_id, user_id=user_id, origin=claims.get("origin", "web"))

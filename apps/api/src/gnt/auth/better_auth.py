from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.auth.api_key import resolve_api_key_row
from gnt.auth.mcp_keys import is_api_key
from gnt.config import get_settings
from gnt.db.rls import scope_to_org
from gnt.db.session import get_session

_bearer = HTTPBearer(auto_error=False)


# Better Auth's organization plugin's own default role vocabulary (owner,
# admin, member) — see apps/web/lib/auth.ts's organization() config, which
# doesn't override it. The org creator defaults to "owner" (creatorRole),
# so owner has to be admin-equivalent here or the founder of a brand new
# org could never pass require_admin on their own org.
_ADMIN_ROLES = {"owner", "admin"}


@dataclass(frozen=True)
class OrgContext:
    org_id: str
    user_id: str
    # None for API-key auth without an is_admin snapshot (org-scoped, not a
    # person — never treated as admin by default, so a service/MCP-serving
    # key can never self-approve a rule). For the session path, this is the
    # caller's member.role within their active org (owner/admin/member —
    # see _ADMIN_ROLES). Set to "admin" for an api_key whose is_admin
    # snapshot is true (see auth_kind) — same _ADMIN_ROLES check either way.
    role: str | None = None
    # Distinguishes a live session from an API key — this is what
    # require_session checks, so an endpoint that mints a NEW admin-capable
    # credential (see routers/settings.py's cli-key endpoint) can refuse to
    # be called with an existing API key, closing the obvious
    # self-escalation path (mint an admin key using an admin key that
    # itself was never supposed to prove a live human is behind the wheel).
    auth_kind: Literal["session", "api_key"] = "session"

    @property
    def is_admin(self) -> bool:
        return self.role in _ADMIN_ROLES


@lru_cache
def _jwks_client() -> jwt.PyJWKClient:
    return jwt.PyJWKClient(f"{get_settings().web_origin}/api/auth/jwks")


def _decode(token: str) -> dict:
    settings = get_settings()
    try:
        signing_key = _jwks_client().get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            # Better Auth's jwt plugin defaults both iss and aud to the
            # app's own BETTER_AUTH_URL (apps/web/lib/auth.ts doesn't
            # override either), which is exactly web_origin from over here
            # — see config.py's comment on that field.
            issuer=settings.web_origin,
            audience=settings.web_origin,
            options={"require": ["exp", "iat", "sub"]},
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or expired session token",
        ) from exc


async def get_current_org(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    session: AsyncSession = Depends(get_session),
) -> OrgContext:
    """Verifies either a Better Auth JWT (web, minted via the jwt plugin's
    /api/auth/token) or an org-scoped API key (MCP clients, the native menu
    bar app — anything that can't hold a browser session) and requires an
    active organization.

    The token nests org data under a compact top-level "o" claim
    ({"o": {"id", "rol"}}), set by apps/web/lib/auth.ts's definePayload —
    this is what makes org_id a safe tenant key everywhere downstream
    instead of something we have to look up.
    """
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing bearer token",
        )

    token = credentials.credentials
    if is_api_key(token):
        # resolve_api_key_row looks up mcp_api_keys by key_hash across every
        # org — that table has no RLS policy (see migration 0007) since
        # this lookup has to run before we know which org's GUC to set.
        key = await resolve_api_key_row(token, session)
        if key is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid api key",
            )
        # API keys are org-scoped, not tied to a user — captures made this
        # way have no individual contributor to attribute to. role is
        # only ever "admin" here if this specific key's is_admin snapshot
        # was set at mint time (see routers/settings.py's cli-key
        # endpoint) — every other key (including all pre-existing ones)
        # defaults to non-admin.
        await scope_to_org(session, key.org_id)
        return OrgContext(
            org_id=key.org_id,
            user_id="api-key",
            role="admin" if key.is_admin else None,
            auth_kind="api_key",
        )

    claims = _decode(token)
    org_claim = claims.get("o", {})
    org_id = org_claim.get("id")
    if not org_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="no active organization on session",
        )

    await scope_to_org(session, org_id)
    return OrgContext(org_id=org_id, user_id=claims["sub"], role=org_claim.get("rol"))


async def require_session(org: OrgContext = Depends(get_current_org)) -> OrgContext:
    """Refuses an API key outright — for endpoints that mint a NEW
    admin-capable credential (see routers/settings.py's cli-key endpoint),
    accepting an existing API key here would let a key mint another key
    with elevated capability, regardless of whether either key's own
    is_admin snapshot says anything about the caller today."""
    if org.auth_kind != "session":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="this action requires a live sign-in, not an API key",
        )
    return org


async def require_admin(org: OrgContext = Depends(get_current_org)) -> OrgContext:
    if not org.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin role required")
    return org


async def require_platform_admin(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str:
    """Gate for the internal platform-admin dashboard (routers/
    platform_admin.py) — deliberately NOT org-scoped, unlike every other
    dependency in this file. Decodes the same Better Auth JWT
    get_current_org does (reusing _decode), but checks the token's "email"
    claim (apps/web/lib/auth.ts's definePayload) against
    settings.platform_admin_email_set instead of resolving an org.

    Session-only by construction, not by an explicit auth_kind check like
    require_admin_session's: an API key's JWT-equivalent (mcp_api_keys) has
    no email claim at all, so it can never satisfy this regardless — there
    is no bearer-token shape that reaches this dependency except a live
    Better Auth session JWT.

    Returns the caller's email (not an OrgContext — there is no org here)
    for anything that wants to log who took a platform-admin action."""
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    claims = _decode(credentials.credentials)
    email = (claims.get("email") or "").strip().lower()
    if not email or email not in get_settings().platform_admin_email_set:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="platform admin access required")
    return email


async def require_admin_session(org: OrgContext = Depends(require_admin)) -> OrgContext:
    """Composes require_admin with require_session's own auth_kind check —
    for the handful of routes (org offboarding) where an admin-snapshotting
    API key being enough is genuinely too permissive. Same self-escalation-
    adjacent posture as create_cli_key's require_session: an MCP/CLI key,
    even one minted with is_admin=True, must not be able to kick off
    something this destructive on its own — only a live human sign-in
    can."""
    if org.auth_kind != "session":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="this action requires a live sign-in, not an API key",
        )
    return org

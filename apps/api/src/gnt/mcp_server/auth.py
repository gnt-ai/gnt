from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from gnt.auth.api_key import resolve_api_key_row
from gnt.billing import is_org_entitled
from gnt.db.rls import scope_to_org
from gnt.db.session import get_sessionmaker
from gnt.mcp_server.context import current_key_id, current_org_id


class McpAuthMiddleware:
    """Resolves the bearer API key to an org_id (and the key's own id, for
    per-key rate limiting) and stashes both in contextvars for the
    duration of the request — mirrors how FastMCP's own Context is
    threaded through tool calls, so it survives into whatever task the
    session manager runs the tool call in."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope["headers"])
        auth_header = headers.get(b"authorization", b"").decode()
        if not auth_header.startswith("Bearer "):
            await JSONResponse({"error": "missing bearer token"}, status_code=401)(scope, receive, send)
            return

        token = auth_header.removeprefix("Bearer ")

        session_factory = get_sessionmaker()
        async with session_factory() as session:
            key = await resolve_api_key_row(token, session)
            if key is None:
                # Same response for "never existed" and "revoked" — telling
                # them apart would let a caller probe whether a specific
                # key value used to be valid.
                await JSONResponse(
                    {"error": "invalid or revoked api key"}, status_code=401
                )(scope, receive, send)
                return

            # orgs is RLS-protected (migration 0007) on current_setting('app.current_org').
            # is_org_entitled scopes and re-scopes around its own internal commit
            # itself now (see billing.py) so this call isn't load-bearing for that
            # specific check — kept anyway to match every other auth path in the
            # codebase (scope right after resolving org identity), since anything
            # added downstream of this check will otherwise silently run unscoped.
            await scope_to_org(session, key.org_id)
            if not await is_org_entitled(session, key.org_id):
                await JSONResponse(
                    {"error": "trial expired and no active subscription"}, status_code=402
                )(scope, receive, send)
                return

        org_ctx = current_org_id.set(key.org_id)
        key_ctx = current_key_id.set(str(key.id))
        try:
            await self.app(scope, receive, send)
        finally:
            current_org_id.reset(org_ctx)
            current_key_id.reset(key_ctx)

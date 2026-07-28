"""McpAuthMiddleware, tested through a real HTTP request over the real
ASGI stack (httpx's ASGITransport) — not by calling functions directly.
test_mcp_tools.py's direct-call tests set current_org_id/current_key_id
by hand and call the tool functions themselves, which is exactly why they
never caught the bug this file guards against: `orgs` is RLS-scoped on
the app.current_org GUC (migration 0007), and billing.is_org_entitled's
own internal session.commit() (right after ensure_org sets that scoping)
silently cleared it again before its own scoped SELECT ran — commit()
ends the transaction a transaction-local set_config(..., true) is scoped
to. Every org's very first entitlement check, through the MCP endpoint
or any REST route gated by require_entitled_org/require_entitled_admin,
hit NoResultFound and 500'd. Confirmed by directly probing a real session
against production (session.commit() reads the GUC back empty
immediately after), not inferred from reading the code alone. Fixed at
the root in billing.is_org_entitled (re-scope after the commit); this
middleware also scopes the session itself now, matching the same
scope-right-after-resolving-org-identity pattern every other auth path
in the codebase already follows.
"""

import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from gnt.auth.mcp_keys import generate_key
from gnt.db.models import McpApiKey
from gnt.db.org import ensure_org
from gnt.mcp_server.auth import McpAuthMiddleware
from gnt.mcp_server.context import current_key_id, current_org_id


async def _stub_downstream(scope, receive, send):
    """Echoes back whatever org_id/key_id the middleware resolved into the
    contextvars — proving both key resolution AND the RLS-gated
    entitlement check succeeded, not just that some response came back."""
    body = f'{{"org_id": "{current_org_id.get()}", "key_id": "{current_key_id.get()}"}}'.encode()
    await send(
        {"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]}
    )
    await send({"type": "http.response.body", "body": body})


@pytest.fixture
async def real_org_and_key(db_session):
    """db_session's own fixture patches gnt.mcp_server.auth's
    get_sessionmaker to share this same connection/transaction — without
    that, the middleware would open a genuinely separate connection that
    can't see this fixture's uncommitted-at-the-real-DB-level seed data."""
    org_id = f"__mcp_auth_test_{uuid.uuid4().hex[:8]}__"
    await ensure_org(db_session, org_id)
    await db_session.commit()
    plaintext, key_hash = generate_key()
    key = McpApiKey(org_id=org_id, key_hash=key_hash, name="auth-test")
    db_session.add(key)
    await db_session.commit()

    # ensure_org() calls scope_to_org() internally as part of its own
    # upsert — since this fixture shares db_session's connection with the
    # middleware (see db_session's own docstring), that leftover scoping
    # could otherwise make this test pass for the wrong reason. Reset it
    # explicitly so the request below only succeeds if the code under
    # test scopes the session itself.
    #
    # Note: this reset does NOT reliably distinguish "middleware fix
    # present vs. absent" locally — db_session's savepoint-based test
    # transactions don't reproduce production's actual failure mode
    # (session.commit() ending a real transaction clears a transaction-
    # local `set_config(..., true)` GUC; a savepoint release inside one
    # long-lived outer transaction does not). The real bug this guards
    # against — billing.is_org_entitled's own internal commit wiping the
    # scoping ensure_org just set, before its own scoped SELECT ran — was
    # confirmed by directly probing a real (non-test) session against
    # production, not by reverting code and rerunning this file.
    await db_session.execute(text("SELECT set_config('app.current_org', '', true)"))
    await db_session.commit()

    return org_id, plaintext


async def test_middleware_authenticates_real_org_via_real_http_request(real_org_and_key):
    org_id, api_key = real_org_and_key
    app = McpAuthMiddleware(_stub_downstream)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/", headers={"Authorization": f"Bearer {api_key}"})

    assert response.status_code == 200
    body = response.json()
    assert body["org_id"] == org_id
    assert body["key_id"]


async def test_middleware_rejects_missing_bearer_token():
    app = McpAuthMiddleware(_stub_downstream)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/")

    assert response.status_code == 401


async def test_middleware_rejects_invalid_key(db_session):
    """db_session isn't used directly -- its fixture is what patches
    gnt.mcp_server.auth's get_sessionmaker onto the migrated test
    connection. Without it, resolve_api_key_row hits the real,
    @lru_cache'd get_sessionmaker(), which points at the unsuffixed base
    database (migrations only ever run against the _test-suffixed one) --
    happened to have the right tables locally by coincidence from
    unrelated earlier work, but not in a clean CI Postgres, where it
    doesn't exist at all."""
    app = McpAuthMiddleware(_stub_downstream)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/", headers={"Authorization": "Bearer gnt_live_bogus"})

    assert response.status_code == 401

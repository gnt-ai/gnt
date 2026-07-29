"""Key expiry and rotation. Covers three things
test_settings_keys.py / test_settings_cli_keys.py don't:

1. resolve_api_key_row now rejects an expired key the same way it already
   rejects a revoked one -- exercised through the REAL (non-overridden)
   auth chain, same pattern test_settings_cli_keys.py's
   test_revoked_cli_key_fails_real_auth_resolution_on_its_next_request
   uses, since that's the only way to prove the rejection actually lands
   on the request path every other authenticated endpoint depends on, not
   just that the column exists.
2. create_cli_key's new 90-day default expiry actually lands on the DB
   row (checked directly, not just echoed back in the response body).
   create_mcp_key deliberately does NOT get a default (see that endpoint's
   own comment in routers/settings.py) -- covered here too so a future
   change can't silently start defaulting MCP keys without a test noticing.
3. gnt keys rotate's backend (/v1/settings/cli-keys/{id}/rotate and
   /v1/settings/mcp-keys/{id}/rotate): mints a genuinely new working key,
   the old one stops working immediately after (through the real auth
   chain again), tenant isolation holds (rotating another org's key is a
   404, no side effects), and the self-escalation gate on the CLI variant
   (an API key must not be able to rotate an admin-capable CLI key into a
   plaintext it could then read) actually rejects an api_key caller.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient

from gnt.auth.mcp_keys import generate_key
from gnt.config import get_settings
from gnt.db.models import McpApiKey
from gnt.db.org import ensure_org
from tests.conftest import make_org_client


@pytest.fixture
def settings_routers():
    from gnt.routers import settings as settings_router

    return [settings_router.router]


@pytest.fixture
def org_a_session(test_app_factory, org_a, settings_routers):
    return make_org_client(
        test_app_factory, org_a, user_id="admin_a", role="admin", routers=settings_routers
    )


@pytest.fixture
def org_b_session(test_app_factory, org_b, settings_routers):
    return make_org_client(
        test_app_factory, org_b, user_id="admin_b", role="admin", routers=settings_routers
    )


def _unique_org_id() -> str:
    return f"org_test_{uuid.uuid4()}"


def _unique_admin_session(test_app_factory, settings_routers):
    """Same reasoning as test_settings_keys.py's own _unique_admin_session:
    create_cli_key and rotate_cli_key both go through
    enforce_cli_key_rate_limit, a real fixed-window Redis counter keyed on
    org_id with a 1-hour TTL. Reusing the shared org_a fixture across every
    test that mints or rotates a CLI key would make this file's own local
    reruns (and any other suite sharing org_a's budget within the same
    hour) flaky for a reason that has nothing to do with the behavior
    under test -- a fresh uuid-suffixed org per test sidesteps that
    entirely. Tests that only need tenant-isolation identity (not a mint)
    still use the shared org_a/org_b fixtures below."""
    org_id = _unique_org_id()
    return org_id, make_org_client(
        test_app_factory, org_id, user_id="admin", role="admin", routers=settings_routers
    )


@pytest.fixture
def api_key_caller(test_app_factory, org_a, settings_routers):
    """Simulates an existing (admin-snapshotted) API key trying to rotate
    a CLI key -- the exact self-escalation path require_session (wrapped
    inside enforce_cli_key_rate_limit) exists to close for create_cli_key,
    and rotate_cli_key inherits the same gate because rotation is also a
    mint. Short-circuits on require_session before check_rate_limit ever
    runs (see rate_limit.enforce_cli_key_rate_limit), so this doesn't
    consume org_a's budget -- safe to keep on the shared fixture."""
    return make_org_client(
        test_app_factory,
        org_a,
        user_id="api-key",
        role="admin",
        auth_kind="api_key",
        routers=settings_routers,
    )


async def _insert_key(
    db_session,
    org_id: str,
    *,
    key_type: str,
    name: str | None = None,
    is_admin: bool = False,
    expires_at: datetime | None = None,
) -> tuple[str, uuid.UUID]:
    """Inserts a real mcp_api_keys row directly, bypassing the minting
    endpoints -- same helper shape as test_settings_cli_keys.py's, plus
    the new expires_at knob."""
    await ensure_org(db_session, org_id)
    plaintext, key_hash = generate_key()
    key = McpApiKey(
        org_id=org_id,
        key_hash=key_hash,
        name=name,
        key_type=key_type,
        is_admin=is_admin,
        expires_at=expires_at,
    )
    db_session.add(key)
    await db_session.commit()
    return plaintext, key.id


# -- default TTL on newly minted CLI keys ------------------------------------


async def test_create_cli_key_sets_the_90_day_default_expiry(test_app_factory, db_session, settings_routers):
    _, session = _unique_admin_session(test_app_factory, settings_routers)
    async with session as client:
        r = await client.post("/v1/settings/cli-key")
        assert r.status_code == 201
        key_id = r.json()["id"]

    row = await db_session.get(McpApiKey, key_id)
    assert row is not None
    assert row.expires_at is not None
    expected = datetime.now(timezone.utc) + timedelta(days=get_settings().cli_key_default_ttl_days)
    # Real clock ticks between the request and this assertion -- a tight
    # tolerance still proves it's "90 days from mint time", not a fixed
    # or wildly wrong value.
    assert abs((row.expires_at - expected).total_seconds()) < 60


async def test_create_mcp_key_leaves_expires_at_null(org_a_session, db_session):
    async with org_a_session as client:
        r = await client.post("/v1/settings/mcp-keys")
        assert r.status_code == 201
        key_id = r.json()["id"]

    row = await db_session.get(McpApiKey, key_id)
    assert row is not None
    assert row.expires_at is None


# -- expired keys fail the real auth resolution path, same as revoked -------


async def test_expired_key_fails_real_auth_resolution_same_as_revoked(test_app_factory, db_session, org_a):
    from gnt.routers import settings as settings_router

    plaintext, _ = await _insert_key(
        db_session,
        org_a,
        key_type="mcp",
        expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
    )

    app = test_app_factory([settings_router.router])
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        client.headers["Authorization"] = f"Bearer {plaintext}"
        r = await client.get("/v1/settings/mcp-keys")
        assert r.status_code == 401


async def test_key_with_future_expiry_still_works(test_app_factory, db_session, org_a):
    from gnt.routers import settings as settings_router

    plaintext, _ = await _insert_key(
        db_session,
        org_a,
        key_type="mcp",
        expires_at=datetime.now(timezone.utc) + timedelta(days=1),
    )

    app = test_app_factory([settings_router.router])
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        client.headers["Authorization"] = f"Bearer {plaintext}"
        r = await client.get("/v1/settings/mcp-keys")
        assert r.status_code == 200


async def test_key_with_null_expiry_still_works(test_app_factory, db_session, org_a):
    from gnt.routers import settings as settings_router

    plaintext, _ = await _insert_key(db_session, org_a, key_type="mcp", expires_at=None)

    app = test_app_factory([settings_router.router])
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        client.headers["Authorization"] = f"Bearer {plaintext}"
        r = await client.get("/v1/settings/mcp-keys")
        assert r.status_code == 200


# -- rotate: cli keys ---------------------------------------------------------


async def test_rotate_cli_key_mints_a_new_working_key_and_the_old_one_stops_working(
    test_app_factory, db_session, settings_routers
):
    from gnt.routers import settings as settings_router

    org_id, session = _unique_admin_session(test_app_factory, settings_routers)
    old_plaintext, old_id = await _insert_key(
        db_session, org_id, key_type="cli", name="laptop", is_admin=True
    )

    async with session as client:
        r = await client.post(f"/v1/settings/cli-keys/{old_id}/rotate")
        assert r.status_code == 201
        body = r.json()

    assert body["key"] != old_plaintext
    assert body["id"] != str(old_id)
    assert body["key_type"] == "cli"
    assert body["expires_at"] is not None

    old_row = await db_session.get(McpApiKey, old_id)
    new_row = await db_session.get(McpApiKey, uuid.UUID(body["id"]))
    assert old_row.revoked_at is not None
    assert new_row is not None
    assert new_row.revoked_at is None
    # is_admin and name carry over from the key being rotated -- rotation
    # is "same credential, new secret", not a fresh mint with the
    # caller's own admin standing.
    assert new_row.is_admin is True
    assert new_row.name == "laptop"

    app = test_app_factory([settings_router.router])
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        client.headers["Authorization"] = f"Bearer {old_plaintext}"
        assert (await client.get("/v1/settings/cli-keys")).status_code == 401

        client.headers["Authorization"] = f"Bearer {body['key']}"
        assert (await client.get("/v1/settings/cli-keys")).status_code == 200


async def test_rotate_cli_key_refuses_another_orgs_key(test_app_factory, db_session, settings_routers):
    victim_org = _unique_org_id()
    _, attacker_session = _unique_admin_session(test_app_factory, settings_routers)
    _, key_id = await _insert_key(db_session, victim_org, key_type="cli", name="a-laptop")

    async with attacker_session as client:
        r = await client.post(f"/v1/settings/cli-keys/{key_id}/rotate")

    assert r.status_code == 404
    row = await db_session.get(McpApiKey, key_id)
    assert row.revoked_at is None


async def test_rotate_cli_key_refuses_an_mcp_type_key_in_the_same_org(test_app_factory, db_session, settings_routers):
    org_id, session = _unique_admin_session(test_app_factory, settings_routers)
    _, mcp_key_id = await _insert_key(db_session, org_id, key_type="mcp", name="agent-1")

    async with session as client:
        r = await client.post(f"/v1/settings/cli-keys/{mcp_key_id}/rotate")

    assert r.status_code == 404
    row = await db_session.get(McpApiKey, mcp_key_id)
    assert row.revoked_at is None


async def test_rotate_an_already_revoked_cli_key_is_a_400_not_a_silent_mint(
    test_app_factory, db_session, settings_routers
):
    org_id, session = _unique_admin_session(test_app_factory, settings_routers)
    _, key_id = await _insert_key(db_session, org_id, key_type="cli")

    async with session as client:
        revoke = await client.post(f"/v1/settings/cli-keys/{key_id}/revoke")
        assert revoke.status_code == 200
        rotate = await client.post(f"/v1/settings/cli-keys/{key_id}/rotate")
        assert rotate.status_code == 400


async def test_rotate_cli_key_refuses_api_key_auth(api_key_caller, db_session, org_a):
    """The self-escalation gate: rotate_cli_key mints a NEW key inheriting
    the OLD row's is_admin snapshot, so an existing API key (even one with
    an admin snapshot of its own) must not be able to rotate ANY CLI key
    in its org into a fresh plaintext -- the same path require_session
    closes for create_cli_key."""
    _, key_id = await _insert_key(db_session, org_a, key_type="cli", is_admin=True)

    async with api_key_caller as client:
        r = await client.post(f"/v1/settings/cli-keys/{key_id}/rotate")

    assert r.status_code == 403
    row = await db_session.get(McpApiKey, key_id)
    assert row.revoked_at is None


# -- rotate: mcp keys ----------------------------------------------------------


async def test_rotate_mcp_key_mints_a_new_working_key_and_the_old_one_stops_working(
    test_app_factory, db_session, org_a, org_a_session
):
    from gnt.routers import settings as settings_router

    old_plaintext, old_id = await _insert_key(db_session, org_a, key_type="mcp", name="agent-1")

    async with org_a_session as client:
        r = await client.post(f"/v1/settings/mcp-keys/{old_id}/rotate")
        assert r.status_code == 201
        body = r.json()

    assert body["key"] != old_plaintext
    assert body["id"] != str(old_id)
    assert body["key_type"] == "mcp"
    assert body["expires_at"] is None

    old_row = await db_session.get(McpApiKey, old_id)
    new_row = await db_session.get(McpApiKey, uuid.UUID(body["id"]))
    assert old_row.revoked_at is not None
    assert new_row.revoked_at is None
    assert new_row.is_admin is False
    assert new_row.name == "agent-1"

    app = test_app_factory([settings_router.router])
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        client.headers["Authorization"] = f"Bearer {old_plaintext}"
        assert (await client.get("/v1/settings/mcp-keys")).status_code == 401

        client.headers["Authorization"] = f"Bearer {body['key']}"
        assert (await client.get("/v1/settings/mcp-keys")).status_code == 200


async def test_rotate_mcp_key_refuses_another_orgs_key(org_b_session, db_session, org_a):
    _, key_id = await _insert_key(db_session, org_a, key_type="mcp", name="agent-1")

    async with org_b_session as client:
        r = await client.post(f"/v1/settings/mcp-keys/{key_id}/rotate")

    assert r.status_code == 404
    row = await db_session.get(McpApiKey, key_id)
    assert row.revoked_at is None


async def test_rotate_mcp_key_refuses_a_cli_type_key_in_the_same_org(org_a_session, db_session, org_a):
    _, cli_key_id = await _insert_key(db_session, org_a, key_type="cli", name="laptop")

    async with org_a_session as client:
        r = await client.post(f"/v1/settings/mcp-keys/{cli_key_id}/rotate")

    assert r.status_code == 404
    row = await db_session.get(McpApiKey, cli_key_id)
    assert row.revoked_at is None


async def test_rotate_mcp_key_shares_create_mcp_keys_rate_limit_budget(
    test_app_factory, db_session, settings_routers
):
    """rotate_mcp_key mints a new row the same way create_mcp_key does --
    picked up enforce_mcp_key_rate_limit in a rebase (a sibling task added
    that dependency to create_mcp_key after this branch forked). Proves
    the two share one budget rather than rotate having its own uncapped
    door around create's limit."""
    org_id, session = _unique_admin_session(test_app_factory, settings_routers)
    limit = get_settings().mcp_key_rate_limit_per_hour

    async with session as client:
        _, key_id = await _insert_key(db_session, org_id, key_type="mcp", name="agent-1")
        # One create already primes the counter at 1; spend the rest on
        # rotate calls against that same row (rotating a key that's now
        # revoked would 400 before the rate check even matters here --
        # each rotate call below targets the CURRENT live key, chaining
        # onto whatever id the previous rotate minted).
        r = await client.post("/v1/settings/mcp-keys")
        assert r.status_code == 201
        current_id = r.json()["id"]
        for _ in range(limit - 1):
            r = await client.post(f"/v1/settings/mcp-keys/{current_id}/rotate")
            assert r.status_code == 201
            current_id = r.json()["id"]

        over_limit = await client.post(f"/v1/settings/mcp-keys/{current_id}/rotate")
        assert over_limit.status_code == 429

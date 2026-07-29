"""CLI keys had no server-side revocation at
all (`gnt logout` only ever deleted the local credentials file; the key
itself stayed valid indefinitely). CLI keys can carry an admin snapshot
(see McpApiKey.is_admin / migration 0010), which is exactly why this
matters more than it sounds.

CLI keys and MCP keys turned out to already share one table
(mcp_api_keys) -- this suite exercises the new key_type column and the
new /v1/settings/cli-keys list/revoke endpoints that filter on it, and
proves two things dependency-override tests alone can't:

1. Tenant isolation is airtight. mcp_api_keys has NO row-level-security
   policy of its own (migration 0007's docstring: resolving a bearer
   token to an org has to happen before the org is known, so RLS can't
   scope this table). That means the org_id equality check inside each
   endpoint IS the entire tenant boundary here, not a Postgres backstop --
   these tests prove it holds, not just that it's present in the code.
2. A revoked key actually fails the REAL (non-overridden) auth resolution
   path on its very next request -- the exact thing `gnt logout` and a
   founder-triggered revoke both depend on -- not just that the revoke
   endpoint itself returns 200.
"""

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from gnt.auth.mcp_keys import generate_key
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


async def _insert_key(
    db_session,
    org_id: str,
    *,
    key_type: str,
    name: str | None = None,
    is_admin: bool = False,
) -> tuple[str, uuid.UUID]:
    """Inserts a real mcp_api_keys row directly and ensures the parent org
    exists -- bypassing the minting endpoints entirely so these tests
    isolate list/revoke/auth-resolution behavior from create_cli_key's own
    minting logic (already covered by test_settings_keys.py)."""
    await ensure_org(db_session, org_id)
    plaintext, key_hash = generate_key()
    key = McpApiKey(org_id=org_id, key_hash=key_hash, name=name, key_type=key_type, is_admin=is_admin)
    db_session.add(key)
    await db_session.commit()
    return plaintext, key.id


# -- listing is scoped by org AND key_type ----------------------------------


async def test_list_cli_keys_only_returns_cli_type_rows(org_a_session, db_session, org_a):
    await _insert_key(db_session, org_a, key_type="cli", name="cli")
    await _insert_key(db_session, org_a, key_type="mcp", name="agent-1")

    async with org_a_session as client:
        r = await client.get("/v1/settings/cli-keys")
        assert r.status_code == 200
        body = r.json()

    assert len(body) == 1
    assert body[0]["name"] == "cli"
    assert body[0]["key_type"] == "cli"


# -- tenant isolation: cannot list or revoke another org's keys -------------


async def test_cli_keys_list_is_scoped_to_the_calling_org(org_b_session, db_session, org_a, org_b):
    await _insert_key(db_session, org_a, key_type="cli", name="a-key")
    await _insert_key(db_session, org_b, key_type="cli", name="b-key")

    async with org_b_session as client:
        r = await client.get("/v1/settings/cli-keys")
        assert r.status_code == 200
        names = [k["name"] for k in r.json()]

    assert names == ["b-key"]


async def test_org_cannot_revoke_another_orgs_cli_key(org_b_session, db_session, org_a):
    _, key_id = await _insert_key(db_session, org_a, key_type="cli", name="a-key")

    async with org_b_session as client:
        r = await client.post(f"/v1/settings/cli-keys/{key_id}/revoke")

    assert r.status_code == 404

    row = await db_session.get(McpApiKey, key_id)
    assert row.revoked_at is None


async def test_org_cannot_list_zero_keys_as_evidence_another_org_has_none(org_b_session, db_session, org_a):
    """A 404 (not a 403 with a body distinguishing "exists elsewhere" from
    "doesn't exist") on cross-org revoke, and an empty list rather than an
    error on cross-org listing -- neither response leaks whether the other
    org's key exists."""
    await _insert_key(db_session, org_a, key_type="cli", name="a-key")

    async with org_b_session as client:
        r = await client.get("/v1/settings/cli-keys")
        assert r.status_code == 200
        assert r.json() == []


async def test_revoke_cli_key_refuses_an_mcp_type_key_in_the_same_org(org_a_session, db_session, org_a):
    """/cli-keys/{id}/revoke must not become a backdoor to revoke an
    mcp-type key by guessing its id -- each endpoint only ever touches its
    own key_type, even within the SAME org."""
    _, mcp_key_id = await _insert_key(db_session, org_a, key_type="mcp", name="agent-1")

    async with org_a_session as client:
        r = await client.post(f"/v1/settings/cli-keys/{mcp_key_id}/revoke")

    assert r.status_code == 404
    row = await db_session.get(McpApiKey, mcp_key_id)
    assert row.revoked_at is None


async def test_revoking_one_cli_key_does_not_touch_another_key_in_the_same_org(org_a_session, db_session, org_a):
    _, revoke_me = await _insert_key(db_session, org_a, key_type="cli", name="stale-laptop")
    _, leave_me = await _insert_key(db_session, org_a, key_type="cli", name="current-laptop")

    async with org_a_session as client:
        r = await client.post(f"/v1/settings/cli-keys/{revoke_me}/revoke")
        assert r.status_code == 200

    revoked_row = await db_session.get(McpApiKey, revoke_me)
    other_row = await db_session.get(McpApiKey, leave_me)
    assert revoked_row.revoked_at is not None
    assert other_row.revoked_at is None


async def test_revoking_an_already_revoked_key_is_a_400_not_a_silent_success(org_a_session, db_session, org_a):
    _, key_id = await _insert_key(db_session, org_a, key_type="cli")

    async with org_a_session as client:
        first = await client.post(f"/v1/settings/cli-keys/{key_id}/revoke")
        assert first.status_code == 200
        second = await client.post(f"/v1/settings/cli-keys/{key_id}/revoke")
        assert second.status_code == 400


# -- real (non-overridden) auth resolution ----------------------------------


async def test_revoked_cli_key_fails_real_auth_resolution_on_its_next_request(test_app_factory, db_session, org_a):
    """No dependency_overrides on auth at all here -- a real HTTP call
    through the real get_current_org -> resolve_api_key_row chain, exactly
    what a revoked `gnt` install hits on its next command. Revokes through
    the real endpoint too (not a raw DB write), so this proves the revoke
    endpoint and the resolution path agree end to end, not just that
    revoked_at rejection logic exists somewhere."""
    from gnt.routers import settings as settings_router

    plaintext, key_id = await _insert_key(db_session, org_a, key_type="cli")

    app = test_app_factory([settings_router.router])
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        client.headers["Authorization"] = f"Bearer {plaintext}"

        before = await client.get("/v1/settings/cli-keys")
        assert before.status_code == 200

        revoke = await client.post(f"/v1/settings/cli-keys/{key_id}/revoke")
        assert revoke.status_code == 200

        after = await client.get("/v1/settings/cli-keys")
        assert after.status_code == 401


async def test_revoking_one_key_does_not_break_real_auth_for_a_sibling_key_in_the_same_org(
    test_app_factory, db_session, org_a
):
    from gnt.routers import settings as settings_router

    stale_plaintext, stale_id = await _insert_key(db_session, org_a, key_type="cli", name="stale")
    current_plaintext, _ = await _insert_key(db_session, org_a, key_type="cli", name="current")

    app = test_app_factory([settings_router.router])
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        client.headers["Authorization"] = f"Bearer {stale_plaintext}"
        revoke = await client.post(f"/v1/settings/cli-keys/{stale_id}/revoke")
        assert revoke.status_code == 200

        client.headers["Authorization"] = f"Bearer {current_plaintext}"
        still_works = await client.get("/v1/settings/cli-keys")
        assert still_works.status_code == 200

"""gnt review needs a CLI credential that can call the admin-gated rule
approve/reject endpoints. The existing mcp_api_keys are deliberately never
admin-capable (a service/MCP-serving key must never self-approve a rule) -
this suite proves the new cli-key minting path (require_session-gated,
snapshots is_admin at mint time) doesn't weaken that, and that a minted
admin key actually works end to end against the real (non-overridden) auth
resolution path - not just the dependency-override shortcut the other
tests in this suite use for the mint-time logic itself.
"""

import uuid

import pytest

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
def admin_session(test_app_factory, org_a, settings_routers):
    # Note: the tests below that hit /v1/settings/cli-key through this
    # fixture each spend one unit of org_a's real cli_key_rate_limit
    # budget (see rate_limit.enforce_cli_key_rate_limit) -- fine for a
    # single suite run since the limit is 10/hour and only a couple of
    # tests use this fixture, but it means org_a's counter isn't reset
    # between local reruns within the same hour like it is in CI (fresh
    # Redis container per job). The rate-limit-specific tests further down
    # deliberately mint their own uuid-suffixed org instead of reusing this
    # fixture, to stay isolated from that.
    return make_org_client(
        test_app_factory, org_a, user_id="admin_a", role="admin", routers=settings_routers
    )


@pytest.fixture
def member_session(test_app_factory, org_a, settings_routers):
    return make_org_client(
        test_app_factory, org_a, user_id="member_a", role=None, routers=settings_routers
    )


@pytest.fixture
def api_key_caller(test_app_factory, org_a, settings_routers):
    """Simulates an existing API key trying to mint a NEW one - the exact
    self-escalation path require_session exists to close, regardless of
    whether this specific key happens to have is_admin=True."""
    return make_org_client(
        test_app_factory,
        org_a,
        user_id="api-key",
        role="admin",
        auth_kind="api_key",
        routers=settings_routers,
    )


async def test_cli_key_refuses_api_key_auth(api_key_caller):
    async with api_key_caller as client:
        r = await client.post("/v1/settings/cli-key")
        assert r.status_code == 403


async def test_cli_key_snapshots_admin_true_for_an_admin_session(admin_session, db_session, org_a):
    async with admin_session as client:
        r = await client.post("/v1/settings/cli-key")
        assert r.status_code == 201
        key_id = r.json()["id"]

    row = await db_session.get(McpApiKey, key_id)
    assert row is not None
    assert row.is_admin is True
    assert row.org_id == org_a


async def test_cli_key_with_login_id_can_be_polled_exactly_once(admin_session):
    """gnt login no longer runs a local server the browser posts back to
    (Chrome's Local Network Access policy blocks that fetch outright now) —
    it polls /v1/settings/cli-key/poll instead. Proves the mint-with-
    login_id -> poll round trip actually hands back the same key, and that
    polling again afterward 404s instead of handing the same key out
    twice."""
    login_id = str(uuid.uuid4())
    async with admin_session as client:
        minted = await client.post("/v1/settings/cli-key", json={"login_id": login_id})
        assert minted.status_code == 201

        polled = await client.get(f"/v1/settings/cli-key/poll?login_id={login_id}")
        assert polled.status_code == 200
        assert polled.json() == {"key": minted.json()["key"], "key_id": minted.json()["id"]}

        again = await client.get(f"/v1/settings/cli-key/poll?login_id={login_id}")
        assert again.status_code == 404


async def test_cli_key_poll_404s_for_an_unknown_login_id(admin_session):
    async with admin_session as client:
        r = await client.get(f"/v1/settings/cli-key/poll?login_id={uuid.uuid4()}")
        assert r.status_code == 404


async def test_cli_key_snapshots_admin_false_for_a_member_session(member_session, db_session):
    async with member_session as client:
        r = await client.post("/v1/settings/cli-key")
        assert r.status_code == 201
        key_id = r.json()["id"]

    row = await db_session.get(McpApiKey, key_id)
    assert row is not None
    assert row.is_admin is False


async def test_mcp_keys_endpoint_never_sets_is_admin_even_for_an_admin_caller(
    admin_session, db_session
):
    """The pre-existing agent/MCP-serving key path is untouched - it must
    keep minting non-admin-capable keys regardless of who's calling it."""
    async with admin_session as client:
        r = await client.post("/v1/settings/mcp-keys")
        assert r.status_code == 201
        key_id = r.json()["id"]

    row = await db_session.get(McpApiKey, key_id)
    assert row is not None
    assert row.is_admin is False


async def _insert_real_key(db_session, org_id: str, *, is_admin: bool) -> str:
    """Inserts a real mcp_api_keys row and ensures the parent org exists,
    bypassing the settings endpoints entirely - isolates this test to just
    "does the real (non-overridden) auth resolution + require_admin chain
    honor is_admin", not the minting endpoint's own logic (covered above)."""
    await ensure_org(db_session, org_id)
    plaintext, key_hash = generate_key()
    db_session.add(McpApiKey(org_id=org_id, key_hash=key_hash, name="test", is_admin=is_admin))
    await db_session.commit()
    return plaintext


async def test_real_admin_snapshotted_key_can_propose_a_rule_end_to_end(
    test_app_factory, db_session, org_a, monkeypatch
):
    """No dependency_overrides on auth at all here - a real API key against
    the real resolve_api_key_row + OrgContext + require_admin chain,
    exactly the path gnt review's propose call actually takes. (Approval
    itself now happens via a merged GitHub PR, confirmed by a webhook - see
    docs/migration/RECONCILE_V2.md - so this only proves the admin gate on
    /propose, not a full approved-status transition.)"""
    from gnt.db.models import GithubConnection
    from gnt.github.client import PullRequestResult
    from gnt.github.crypto import encrypt_token
    from gnt.routers import rules as rules_router
    from gnt.routers import settings as settings_router

    admin_key = await _insert_real_key(db_session, org_a, is_admin=True)
    member_key = await _insert_real_key(db_session, org_a, is_admin=False)
    db_session.add(
        GithubConnection(
            org_id=org_a,
            repo_url="https://github.com/acme/rules",
            default_branch="main",
            pat_encrypted=encrypt_token("fake-test-pat"),
            webhook_secret_encrypted=encrypt_token("fake-test-webhook-secret"),
            installed_by_user_id="admin_a",
        )
    )
    await db_session.commit()

    async def _fake_create_branch(*args, **kwargs):
        return None

    async def _fake_put_file(*args, **kwargs):
        return None

    async def _fake_open_pull_request(*args, **kwargs):
        return PullRequestResult(number=1, url="https://github.com/acme/rules/pull/1")

    monkeypatch.setattr("gnt.routers.rules.create_branch", _fake_create_branch)
    monkeypatch.setattr("gnt.routers.rules.put_file", _fake_put_file)
    monkeypatch.setattr("gnt.routers.rules.open_pull_request", _fake_open_pull_request)

    app = test_app_factory([rules_router.router, settings_router.router])
    from httpx import ASGITransport, AsyncClient

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        client.headers["Authorization"] = f"Bearer {member_key}"
        create = await client.post(
            "/v1/rules", json={"title": "Refund window", "body": "Refunds within 30 days."}
        )
        assert create.status_code == 201
        rule_id = create.json()["id"]
        submit = await client.post(f"/v1/rules/{rule_id}/submit")
        assert submit.status_code == 200

        # The member-snapshotted key can read/submit but not propose.
        denied = await client.post(f"/v1/rules/{rule_id}/propose")
        assert denied.status_code == 403

        client.headers["Authorization"] = f"Bearer {admin_key}"
        proposed = await client.post(f"/v1/rules/{rule_id}/propose")
        assert proposed.status_code == 200
        assert proposed.json()["status"] == "pending_merge"


# -- rate limiting: create_cli_key used to have no budget at all -- anyone
# with a live session (compromised or scripted) could mint unlimited
# admin-snapshotting CLI credentials. ------------------------------------
#
# These use their own uuid-suffixed org ids rather than the shared
# org_a/org_b fixtures: check_rate_limit's fixed-window key
# (cli_key_rate_limit:<org_id>) lives in real Redis with a 1-hour TTL, so
# reusing a fixed org id across test runs within the same hour would let
# one run's counter bleed into the next and make these flaky.


def _unique_admin_session(test_app_factory, settings_routers):
    org_id = f"org_test_{uuid.uuid4()}"
    return make_org_client(
        test_app_factory, org_id, user_id="admin", role="admin", routers=settings_routers
    )


async def test_create_cli_key_rejects_once_the_per_hour_limit_is_exceeded(
    test_app_factory, settings_routers
):
    limit = get_settings().cli_key_rate_limit_per_hour

    async with _unique_admin_session(test_app_factory, settings_routers) as client:
        for _ in range(limit):
            r = await client.post("/v1/settings/cli-key")
            assert r.status_code == 201

        over_limit = await client.post("/v1/settings/cli-key")
        assert over_limit.status_code == 429


async def test_create_cli_key_rate_limit_is_scoped_per_org(test_app_factory, settings_routers):
    """One org exhausting its budget must not touch another org's -- the
    limiter keys on org_id (see check_rate_limit), same as
    capture/transcribe's existing per-org budgets."""
    limit = get_settings().cli_key_rate_limit_per_hour

    async with _unique_admin_session(test_app_factory, settings_routers) as client:
        for _ in range(limit):
            r = await client.post("/v1/settings/cli-key")
            assert r.status_code == 201
        assert (await client.post("/v1/settings/cli-key")).status_code == 429

    async with _unique_admin_session(test_app_factory, settings_routers) as client:
        still_works = await client.post("/v1/settings/cli-key")
        assert still_works.status_code == 201


# -- create_mcp_key used to have no rate limit at all. Same isolated-
# org-id pattern as the cli-key tests above, same reason (check_rate_limit's
# Redis key persists for an hour). ----------------------------------------


async def test_create_mcp_key_rejects_once_the_per_hour_limit_is_exceeded(
    test_app_factory, settings_routers
):
    limit = get_settings().mcp_key_rate_limit_per_hour

    async with _unique_admin_session(test_app_factory, settings_routers) as client:
        for _ in range(limit):
            r = await client.post("/v1/settings/mcp-keys")
            assert r.status_code == 201

        over_limit = await client.post("/v1/settings/mcp-keys")
        assert over_limit.status_code == 429


async def test_create_mcp_key_rate_limit_is_scoped_per_org(test_app_factory, settings_routers):
    limit = get_settings().mcp_key_rate_limit_per_hour

    async with _unique_admin_session(test_app_factory, settings_routers) as client:
        for _ in range(limit):
            r = await client.post("/v1/settings/mcp-keys")
            assert r.status_code == 201
        assert (await client.post("/v1/settings/mcp-keys")).status_code == 429

    async with _unique_admin_session(test_app_factory, settings_routers) as client:
        still_works = await client.post("/v1/settings/mcp-keys")
        assert still_works.status_code == 201


async def test_create_mcp_key_allows_api_key_caller_unlike_cli_key(
    test_app_factory, org_a, settings_routers
):
    """create_mcp_key never sets is_admin=True regardless of caller (see
    test_mcp_keys_endpoint_never_sets_is_admin_even_for_an_admin_caller
    above), so unlike create_cli_key it has no self-escalation path to
    close -- an existing API key IS allowed to mint another MCP key. Proves
    the rate-limit dependency swap didn't accidentally start requiring a
    live session the way enforce_cli_key_rate_limit does."""
    api_key_caller = make_org_client(
        test_app_factory,
        org_a,
        user_id="api-key",
        role=None,
        auth_kind="api_key",
        routers=settings_routers,
    )
    async with api_key_caller as client:
        r = await client.post("/v1/settings/mcp-keys")
        assert r.status_code == 201

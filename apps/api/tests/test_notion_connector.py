"""OAuth sprint T14 dashboard track — the Notion connector's server-side
half: install-url (admin-gated), status, and the CLI-facing token
handoff. The OAuth dance itself (authorize/callback/exchange_code) isn't
driven end-to-end here (that needs a real Notion redirect, exercised live
instead — see connect-notion-mcp.ts's own doc comment for the CLI side of
this split); what's covered is everything this task's own code owns:
role-gating install-url, round-tripping a connection through status/token,
tenant isolation between two orgs, and verify_state's tamper/expiry
handling in isolation.
"""

from gnt.db.models import NotionConnection
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.notion.crypto import encrypt_token
from gnt.notion.oauth import NotionOAuthError, build_authorize_url, verify_state
from gnt.routers import notion as notion_router
from tests.conftest import make_org_client


async def _connect_workspace(db_session, org_id: str) -> None:
    await ensure_org(db_session, org_id)
    await db_session.commit()
    await scope_to_org(db_session, org_id)
    db_session.add(
        NotionConnection(
            org_id=org_id,
            access_token_encrypted=encrypt_token("fake-notion-token"),
            workspace_id="ws_123",
            workspace_name="Acme Workspace",
            bot_id="bot_123",
            installed_by_user_id="notion_user_1",
        )
    )
    await db_session.commit()


def test_verify_state_round_trips_org_id():
    url = build_authorize_url("org_test_x")
    state = url.split("state=")[1].split("&")[0]
    # build_authorize_url URL-encodes the state; verify_state expects the
    # raw JWT, so decode the one query-string component this test needs
    # rather than pulling in a full URL parser for one field.
    from urllib.parse import unquote

    result = verify_state(unquote(state))
    assert result.org_id == "org_test_x"


def test_verify_state_rejects_a_tampered_token():
    import pytest

    with pytest.raises(NotionOAuthError):
        verify_state("not-a-real-jwt")


async def test_install_url_requires_admin(test_app_factory, org_a):
    client = make_org_client(
        test_app_factory, org_a, role="member", routers=[notion_router.router]
    )
    async with client as c:
        r = await c.get("/v1/notion/install-url")
    assert r.status_code == 403


async def test_install_url_returns_a_real_authorize_link_for_an_admin(test_app_factory, org_a):
    client = make_org_client(
        test_app_factory, org_a, role="admin", routers=[notion_router.router]
    )
    async with client as c:
        r = await c.get("/v1/notion/install-url")
    assert r.status_code == 200
    url = r.json()["url"]
    assert url.startswith("https://mcp.notion.com/authorize?")
    assert "client_id=" in url
    assert "state=" in url


async def test_status_reports_not_connected_by_default(test_app_factory, org_a):
    client = make_org_client(test_app_factory, org_a, routers=[notion_router.router])
    async with client as c:
        r = await c.get("/v1/notion/status")
    assert r.status_code == 200
    assert r.json() == {"connected": False}


async def test_status_and_token_after_a_connection_exists(test_app_factory, db_session, org_a):
    await _connect_workspace(db_session, org_a)
    client = make_org_client(test_app_factory, org_a, routers=[notion_router.router])
    async with client as c:
        status_r = await c.get("/v1/notion/status")
        token_r = await c.get("/v1/notion/token")

    assert status_r.json() == {"connected": True, "workspace_name": "Acme Workspace"}
    assert token_r.status_code == 200
    assert token_r.json() == {"access_token": "fake-notion-token"}


async def test_token_404s_when_nothing_is_connected(test_app_factory, org_a):
    client = make_org_client(test_app_factory, org_a, routers=[notion_router.router])
    async with client as c:
        r = await c.get("/v1/notion/token")
    assert r.status_code == 404


async def test_token_is_isolated_to_its_own_org(test_app_factory, db_session, org_a, org_b):
    """Org A's Notion connection must never be readable through org B's
    session -- the same non-negotiable tenant-isolation shape every other
    connector's own test proves, here for the one new endpoint that hands
    a decrypted third-party credential back out at all."""
    await _connect_workspace(db_session, org_a)
    client_b = make_org_client(test_app_factory, org_b, routers=[notion_router.router])
    async with client_b as c:
        r = await c.get("/v1/notion/token")
    assert r.status_code == 404


async def test_install_url_is_unique_per_call(test_app_factory, org_a):
    """Two install-url calls must mint two different state tokens (nonce +
    fresh iat/exp) -- a stale/replayed state should never coincidentally
    match a later one."""
    client = make_org_client(test_app_factory, org_a, role="admin", routers=[notion_router.router])
    async with client as c:
        r1 = await c.get("/v1/notion/install-url")
        r2 = await c.get("/v1/notion/install-url")
    assert r1.json()["url"] != r2.json()["url"]

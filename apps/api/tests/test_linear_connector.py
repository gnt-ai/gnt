"""OAuth sprint T14 dashboard track — the Linear connector's server-side
half. Same coverage shape as test_notion_connector.py (see that file's own
docstring for what's covered here vs. exercised live), plus one thing
specific to this connector: the code_verifier PKCE round trip through the
signed state, since Linear's flow (unlike Notion's) has no client secret
to fall back on -- the verifier surviving the redirect intact is the whole
security story for this one.
"""

import pytest

from gnt.db.models import LinearConnection
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.linear.crypto import encrypt_token
from gnt.linear.oauth import LinearOAuthError, build_authorize_url, verify_state
from gnt.routers import linear as linear_router
from tests.conftest import make_org_client


async def _connect_workspace(db_session, org_id: str) -> None:
    await ensure_org(db_session, org_id)
    await db_session.commit()
    await scope_to_org(db_session, org_id)
    db_session.add(
        LinearConnection(
            org_id=org_id,
            access_token_encrypted=encrypt_token("fake-linear-token"),
            installed_by_user_id="user_test",
        )
    )
    await db_session.commit()


def test_verify_state_round_trips_org_id_user_id_and_code_verifier():
    url = build_authorize_url("org_test_x", "user_test_x")
    from urllib.parse import parse_qs, urlsplit

    query = parse_qs(urlsplit(url).query)
    state = query["state"][0]
    challenge = query["code_challenge"][0]

    result = verify_state(state)
    assert result.org_id == "org_test_x"
    assert result.user_id == "user_test_x"
    assert result.code_verifier

    # The verifier that comes back out of the state must be the one whose
    # SHA-256 produced the challenge sent in the authorize URL -- same
    # "confirm the pair was actually used, not a stubbed constant" proof
    # the CLI's own oauth.test.ts already applies to this exact PKCE
    # invariant.
    import base64
    import hashlib

    recomputed = base64.urlsafe_b64encode(hashlib.sha256(result.code_verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    assert recomputed == challenge


def test_verify_state_rejects_a_tampered_token():
    with pytest.raises(LinearOAuthError):
        verify_state("not-a-real-jwt")


async def test_install_url_requires_admin(test_app_factory, org_a):
    client = make_org_client(
        test_app_factory, org_a, role="member", routers=[linear_router.router]
    )
    async with client as c:
        r = await c.get("/v1/linear/install-url")
    assert r.status_code == 403


async def test_install_url_returns_a_real_authorize_link_for_an_admin(test_app_factory, org_a):
    client = make_org_client(
        test_app_factory, org_a, role="admin", routers=[linear_router.router]
    )
    async with client as c:
        r = await c.get("/v1/linear/install-url")
    assert r.status_code == 200
    url = r.json()["url"]
    assert url.startswith("https://linear.app/oauth/authorize?")
    assert "code_challenge=" in url
    assert "code_challenge_method=S256" in url
    assert "client_secret" not in url


async def test_status_reports_not_connected_by_default(test_app_factory, org_a):
    client = make_org_client(test_app_factory, org_a, routers=[linear_router.router])
    async with client as c:
        r = await c.get("/v1/linear/status")
    assert r.status_code == 200
    assert r.json() == {"connected": False}


async def test_status_and_token_after_a_connection_exists(test_app_factory, db_session, org_a):
    await _connect_workspace(db_session, org_a)
    client = make_org_client(test_app_factory, org_a, routers=[linear_router.router])
    async with client as c:
        status_r = await c.get("/v1/linear/status")
        token_r = await c.get("/v1/linear/token")

    assert status_r.json() == {"connected": True}
    assert token_r.status_code == 200
    assert token_r.json() == {"access_token": "fake-linear-token"}


async def test_token_404s_when_nothing_is_connected(test_app_factory, org_a):
    client = make_org_client(test_app_factory, org_a, routers=[linear_router.router])
    async with client as c:
        r = await c.get("/v1/linear/token")
    assert r.status_code == 404


async def test_token_is_isolated_to_its_own_org(test_app_factory, db_session, org_a, org_b):
    await _connect_workspace(db_session, org_a)
    client_b = make_org_client(test_app_factory, org_b, routers=[linear_router.router])
    async with client_b as c:
        r = await c.get("/v1/linear/token")
    assert r.status_code == 404

"""gnt connect github needs a per-org repo connection before any
git-native storage work can use it. This suite covers: connect requires
admin (an org-wide, admin-gated action like the Slack install, not a
read/write-anyone-can-mint pattern), a malformed repo_url rejects before
any network call, a successful connect persists an encrypted PAT and never
returns it, and disconnect actually removes the row.
"""

import pytest
from sqlalchemy import select

from gnt.db.models import GithubConnection
from tests.conftest import make_org_client


@pytest.fixture
def github_routers():
    from gnt.routers import github as github_router

    return [github_router.router]


@pytest.fixture
def admin_session(test_app_factory, org_a, github_routers):
    return make_org_client(test_app_factory, org_a, user_id="admin_a", role="admin", routers=github_routers)


@pytest.fixture
def member_session(test_app_factory, org_a, github_routers):
    return make_org_client(test_app_factory, org_a, user_id="member_a", role=None, routers=github_routers)


@pytest.fixture
def _fake_repo_access(monkeypatch):
    """Mocks every external call connect_github makes on a successful
    path: the GitHub repo-access check, apps/store's source registration,
    and GitHub webhook creation. Real network/GitHub-API calls stay
    reserved for the actual gnt connect github manual verification pass."""

    async def _verify(repo_url: str, pat: str) -> str:
        return "main"

    async def _register_source(org_id: str, repo_url: str, pat: str) -> None:
        return None

    async def _create_webhook(repo_url: str, pat: str, webhook_url: str, secret: str) -> None:
        return None

    monkeypatch.setattr("gnt.routers.github.verify_repo_access", _verify)
    monkeypatch.setattr("gnt.routers.github.register_github_source", _register_source)
    monkeypatch.setattr("gnt.routers.github.create_webhook", _create_webhook)


async def test_connect_requires_admin(member_session):
    async with member_session as client:
        r = await client.post("/v1/settings/github", json={"repo_url": "https://github.com/acme/rules", "pat": "x"})
        assert r.status_code == 403


async def test_connect_rejects_bad_repo_url_shape_before_any_network_call(admin_session):
    # No _fake_repo_access here — the real verify_repo_access runs, and a
    # malformed repo_url must fail inside parse_repo_url before any httpx
    # call is attempted, so this stays a fast, network-free test.
    async with admin_session as client:
        r = await client.post(
            "/v1/settings/github",
            json={"repo_url": "not-a-real-url", "pat": "x"},
        )
        assert r.status_code == 422


async def test_connect_persists_encrypted_pat_and_never_returns_it(
    admin_session, db_session, org_a, _fake_repo_access
):
    async with admin_session as client:
        r = await client.post(
            "/v1/settings/github",
            json={"repo_url": "https://github.com/acme/rules", "pat": "gph_secret_value"},
        )
        assert r.status_code == 201
        body = r.json()
        assert body == {
            "repo_url": "https://github.com/acme/rules",
            "default_branch": "main",
            "connected": True,
            "connection_type": "pat",
        }
        assert "pat" not in body
        assert "pat_encrypted" not in body

    row = (
        await db_session.execute(select(GithubConnection).where(GithubConnection.org_id == org_a))
    ).scalar_one()
    assert row.pat_encrypted != "gph_secret_value"

    from gnt.github.crypto import decrypt_token

    assert decrypt_token(row.pat_encrypted) == "gph_secret_value"


async def test_connect_stores_the_real_default_branch_not_a_static_guess(
    admin_session, monkeypatch, _fake_repo_access
):
    async def _verify(repo_url: str, pat: str) -> str:
        return "trunk"

    monkeypatch.setattr("gnt.routers.github.verify_repo_access", _verify)

    async with admin_session as client:
        r = await client.post(
            "/v1/settings/github",
            json={"repo_url": "https://github.com/acme/rules", "pat": "x"},
        )
        assert r.status_code == 201
        assert r.json()["default_branch"] == "trunk"


async def test_connect_reports_a_clean_422_when_github_is_unreachable(admin_session, monkeypatch):
    import httpx

    async def _raise_connect_error(self, *args, **kwargs):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx.AsyncClient, "get", _raise_connect_error)

    async with admin_session as client:
        r = await client.post(
            "/v1/settings/github",
            json={"repo_url": "https://github.com/acme/rules", "pat": "x"},
        )
        assert r.status_code == 422
        assert "could not reach" in r.json()["detail"]


async def test_get_connection_reports_not_connected_when_none_exists(admin_session):
    async with admin_session as client:
        r = await client.get("/v1/settings/github")
        assert r.status_code == 200
        assert r.json() == {"connected": False}


async def test_disconnect_removes_the_connection(admin_session, _fake_repo_access):
    async with admin_session as client:
        connect = await client.post(
            "/v1/settings/github",
            json={"repo_url": "https://github.com/acme/rules", "pat": "x"},
        )
        assert connect.status_code == 201

        delete = await client.delete("/v1/settings/github")
        assert delete.status_code == 204

        after = await client.get("/v1/settings/github")
        assert after.json() == {"connected": False}


async def test_disconnect_404s_when_nothing_connected(admin_session):
    async with admin_session as client:
        r = await client.delete("/v1/settings/github")
        assert r.status_code == 404


async def test_disconnect_uninstalls_the_app_for_an_app_connected_org(admin_session, db_session, org_a, monkeypatch):
    from gnt.db.org import ensure_org

    await ensure_org(db_session, org_a)
    db_session.add(
        GithubConnection(
            org_id=org_a,
            repo_url="https://github.com/acme/rules",
            default_branch="main",
            installation_id=42,
            pat_encrypted=None,
            webhook_secret_encrypted=None,
            installed_by_user_id="admin_a",
        )
    )
    await db_session.commit()

    uninstalled_ids: list[int] = []

    async def _fake_uninstall(installation_id: int) -> None:
        uninstalled_ids.append(installation_id)

    monkeypatch.setattr("gnt.routers.github.uninstall_app", _fake_uninstall)

    async with admin_session as client:
        r = await client.delete("/v1/settings/github")
        assert r.status_code == 204
    assert uninstalled_ids == [42]


async def test_disconnect_does_not_call_uninstall_for_a_pat_connected_org(admin_session, _fake_repo_access, monkeypatch):
    called = False

    async def _fake_uninstall(installation_id: int) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr("gnt.routers.github.uninstall_app", _fake_uninstall)

    async with admin_session as client:
        connect = await client.post(
            "/v1/settings/github", json={"repo_url": "https://github.com/acme/rules", "pat": "x"}
        )
        assert connect.status_code == 201
        delete = await client.delete("/v1/settings/github")
        assert delete.status_code == 204
    assert called is False


# -- GitHub App install flow -------------------------------------------


@pytest.fixture
def app_configured(monkeypatch):
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

    from gnt.config import get_settings

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(Encoding.PEM, PrivateFormat.TraditionalOpenSSL, NoEncryption()).decode("utf-8")
    settings = get_settings()
    monkeypatch.setattr(settings, "github_app_id", "999111")
    monkeypatch.setattr(settings, "github_app_private_key", pem)
    return settings


async def test_install_url_requires_admin(member_session, app_configured):
    async with member_session as client:
        r = await client.get("/v1/settings/github/app/install-url")
        assert r.status_code == 403


async def test_install_url_returns_a_real_install_url_with_signed_state(admin_session, app_configured, monkeypatch):
    async def _fake_get_app_slug() -> str:
        return "gnt-ai-connector"

    monkeypatch.setattr("gnt.routers.github.get_app_slug", _fake_get_app_slug)

    async with admin_session as client:
        r = await client.get("/v1/settings/github/app/install-url")
        assert r.status_code == 200
        url = r.json()["url"]
        assert url.startswith("https://github.com/apps/gnt-ai-connector/installations/new?state=")

    from gnt.github.app_auth import verify_install_state

    state = url.split("state=", 1)[1]
    result = verify_install_state(state)
    assert result.org_id == "org_test_a"
    assert result.user_id == "admin_a"


async def test_callback_rejects_a_missing_or_invalid_state(admin_session, app_configured):
    async with admin_session as client:
        missing = await client.get(
            "/v1/settings/github/app/callback", params={"installation_id": 1, "setup_action": "install"}
        )
        assert missing.status_code == 400

        tampered = await client.get(
            "/v1/settings/github/app/callback",
            params={"installation_id": 1, "setup_action": "install", "state": "not-a-real-token"},
        )
        assert tampered.status_code == 400


async def test_callback_persists_the_connection_and_swaps_a_pat_row_over_on_upgrade(
    admin_session, db_session, org_a, app_configured, monkeypatch, _fake_repo_access
):
    """`gnt connect github --upgrade` mechanically IS this same callback —
    an org that's already PAT-connected gets its row swapped to the App
    shape in place (installation_id set, pat/webhook_secret cleared), same
    org_id, same upsert connect_github's own PAT path already used."""
    from gnt.github.app_auth import build_install_state

    async def _fake_list_repos(installation_id: int) -> list[dict]:
        assert installation_id == 555
        return [{"full_name": "acme/rules", "default_branch": "trunk"}]

    monkeypatch.setattr("gnt.routers.github.list_installation_repos", _fake_list_repos)

    async with admin_session as client:
        connect = await client.post(
            "/v1/settings/github", json={"repo_url": "https://github.com/acme/rules", "pat": "x"}
        )
        assert connect.status_code == 201

        state = build_install_state(org_a, "admin_a", origin="cli")
        callback = await client.get(
            "/v1/settings/github/app/callback",
            params={"installation_id": 555, "setup_action": "install", "state": state},
        )
        assert callback.status_code == 200
        assert callback.json() == {"ok": True, "origin": "cli", "repo_url": "https://github.com/acme/rules"}

    row = (
        await db_session.execute(select(GithubConnection).where(GithubConnection.org_id == org_a))
    ).scalar_one()
    assert row.installation_id == 555
    assert row.default_branch == "trunk"
    assert row.pat_encrypted is None
    assert row.webhook_secret_encrypted is None


async def test_callback_rejects_more_than_one_selected_repo(admin_session, db_session, org_a, app_configured, monkeypatch):
    from gnt.github.app_auth import build_install_state

    async def _fake_list_repos(installation_id: int) -> list[dict]:
        return [
            {"full_name": "acme/rules", "default_branch": "main"},
            {"full_name": "acme/other", "default_branch": "main"},
        ]

    monkeypatch.setattr("gnt.routers.github.list_installation_repos", _fake_list_repos)

    async with admin_session as client:
        state = build_install_state(org_a, "admin_a")
        r = await client.get(
            "/v1/settings/github/app/callback",
            params={"installation_id": 555, "setup_action": "install", "state": state},
        )
        assert r.status_code == 422

    row = (
        await db_session.execute(select(GithubConnection).where(GithubConnection.org_id == org_a))
    ).scalar_one_or_none()
    assert row is None

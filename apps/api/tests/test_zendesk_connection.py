"""gnt connect zendesk — connect/get/disconnect/sync-status. Mirrors
test_github_connection.py's shape (same admin-gating, same "live-validate
before persisting, never return the secret" discipline)."""

import pytest
from sqlalchemy import select

from gnt.db.models import ZendeskConnection
from tests.conftest import make_org_client


@pytest.fixture
def zendesk_routers():
    from gnt.routers import zendesk as zendesk_router

    return [zendesk_router.router]


@pytest.fixture
def admin_session(test_app_factory, org_a, zendesk_routers):
    return make_org_client(test_app_factory, org_a, user_id="admin_a", role="admin", routers=zendesk_routers)


@pytest.fixture
def member_session(test_app_factory, org_a, zendesk_routers):
    return make_org_client(test_app_factory, org_a, user_id="member_a", role=None, routers=zendesk_routers)


@pytest.fixture
def _fake_verify(monkeypatch):
    async def _verify(subdomain: str, agent_email: str, api_token: str) -> None:
        return None

    monkeypatch.setattr("gnt.routers.zendesk.verify_credentials", _verify)


async def test_connect_requires_admin(member_session):
    async with member_session as client:
        r = await client.post(
            "/v1/settings/zendesk",
            json={"subdomain": "acme", "agent_email": "agent@acme.com", "api_token": "x"},
        )
        assert r.status_code == 403


async def test_connect_rejects_bad_credentials_before_persisting(admin_session, monkeypatch):
    from gnt.zendesk.client import ZendeskClientError

    async def _fail(subdomain, agent_email, api_token):
        raise ZendeskClientError("could not access acme with the provided token (401)")

    monkeypatch.setattr("gnt.routers.zendesk.verify_credentials", _fail)

    async with admin_session as client:
        r = await client.post(
            "/v1/settings/zendesk",
            json={"subdomain": "acme", "agent_email": "agent@acme.com", "api_token": "bad-token"},
        )
        assert r.status_code == 422
        assert "could not access" in r.json()["detail"]


async def test_connect_persists_encrypted_token_and_never_returns_it(
    admin_session, db_session, org_a, _fake_verify
):
    async with admin_session as client:
        r = await client.post(
            "/v1/settings/zendesk",
            json={"subdomain": "acme", "agent_email": "agent@acme.com", "api_token": "zendesk_secret_value"},
        )
        assert r.status_code == 201
        body = r.json()
        assert body == {"subdomain": "acme", "agent_email": "agent@acme.com", "connected": True}
        assert "api_token" not in body
        assert "api_token_encrypted" not in body

    row = (
        await db_session.execute(select(ZendeskConnection).where(ZendeskConnection.org_id == org_a))
    ).scalar_one()
    assert row.api_token_encrypted != "zendesk_secret_value"

    from gnt.zendesk.crypto import decrypt_token

    assert decrypt_token(row.api_token_encrypted) == "zendesk_secret_value"


async def test_reconnect_upserts_rather_than_duplicating(admin_session, db_session, org_a, _fake_verify):
    async with admin_session as client:
        first = await client.post(
            "/v1/settings/zendesk",
            json={"subdomain": "acme", "agent_email": "agent@acme.com", "api_token": "tok1"},
        )
        assert first.status_code == 201

        second = await client.post(
            "/v1/settings/zendesk",
            json={"subdomain": "acme-2", "agent_email": "agent2@acme.com", "api_token": "tok2"},
        )
        assert second.status_code == 201
        assert second.json()["subdomain"] == "acme-2"

    rows = (
        await db_session.execute(select(ZendeskConnection).where(ZendeskConnection.org_id == org_a))
    ).scalars().all()
    assert len(rows) == 1
    assert rows[0].subdomain == "acme-2"


async def test_get_connection_reports_not_connected_when_none_exists(admin_session):
    async with admin_session as client:
        r = await client.get("/v1/settings/zendesk")
        assert r.status_code == 200
        assert r.json() == {"connected": False}


async def test_disconnect_removes_the_connection(admin_session, _fake_verify):
    async with admin_session as client:
        connect = await client.post(
            "/v1/settings/zendesk",
            json={"subdomain": "acme", "agent_email": "agent@acme.com", "api_token": "tok"},
        )
        assert connect.status_code == 201

        delete = await client.delete("/v1/settings/zendesk")
        assert delete.status_code == 204

        after = await client.get("/v1/settings/zendesk")
        assert after.json() == {"connected": False}


async def test_disconnect_404s_when_nothing_connected(admin_session):
    async with admin_session as client:
        r = await client.delete("/v1/settings/zendesk")
        assert r.status_code == 404


async def test_disconnect_requires_admin(member_session):
    async with member_session as client:
        r = await client.delete("/v1/settings/zendesk")
        assert r.status_code == 403


async def test_sync_status_reports_never_synced_before_any_run(admin_session):
    async with admin_session as client:
        r = await client.get("/v1/settings/zendesk/sync-status")
        assert r.status_code == 200
        assert r.json() == {
            "last_synced_at": None,
            "last_success_at": None,
            "last_error": None,
            "last_error_at": None,
            "items_scanned_last_run": 0,
            "candidates_proposed_last_run": 0,
        }


async def test_sync_status_reflects_a_recorded_run(admin_session, db_session, org_a):
    from gnt.db.org import ensure_org
    from gnt.zendesk_sync_status import record_sync_result

    await ensure_org(db_session, org_a)
    await db_session.commit()
    await record_sync_result(
        db_session, org_a, ok=True, error=None, items_scanned=12, candidates_proposed=3
    )

    async with admin_session as client:
        r = await client.get("/v1/settings/zendesk/sync-status")
        body = r.json()
        assert body["last_error"] is None
        assert body["items_scanned_last_run"] == 12
        assert body["candidates_proposed_last_run"] == 3
        assert body["last_success_at"] is not None
        assert body["last_synced_at"] is not None

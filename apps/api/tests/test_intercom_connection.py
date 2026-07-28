"""gnt connect intercom — connect/get/disconnect/sync-status. Mirrors
test_zendesk_connection.py's shape (same admin-gating, same "live-validate
before persisting, never return the secret" discipline)."""

import pytest
from sqlalchemy import select

from gnt.db.models import IntercomConnection
from tests.conftest import make_org_client


@pytest.fixture
def intercom_routers():
    from gnt.routers import intercom as intercom_router

    return [intercom_router.router]


@pytest.fixture
def admin_session(test_app_factory, org_a, intercom_routers):
    return make_org_client(test_app_factory, org_a, user_id="admin_a", role="admin", routers=intercom_routers)


@pytest.fixture
def member_session(test_app_factory, org_a, intercom_routers):
    return make_org_client(test_app_factory, org_a, user_id="member_a", role=None, routers=intercom_routers)


@pytest.fixture
def _fake_verify(monkeypatch):
    async def _verify(access_token: str) -> None:
        return None

    monkeypatch.setattr("gnt.routers.intercom.verify_credentials", _verify)


async def test_connect_requires_admin(member_session):
    async with member_session as client:
        r = await client.post("/v1/settings/intercom", json={"access_token": "x"})
        assert r.status_code == 403


async def test_connect_rejects_bad_credentials_before_persisting(admin_session, monkeypatch):
    from gnt.intercom.client import IntercomClientError

    async def _fail(access_token):
        raise IntercomClientError("Intercom returned 401 for /me: token invalid")

    monkeypatch.setattr("gnt.routers.intercom.verify_credentials", _fail)

    async with admin_session as client:
        r = await client.post("/v1/settings/intercom", json={"access_token": "bad-token"})
        assert r.status_code == 422
        assert "token invalid" in r.json()["detail"]


async def test_connect_persists_encrypted_token_and_never_returns_it(
    admin_session, db_session, org_a, _fake_verify
):
    async with admin_session as client:
        r = await client.post("/v1/settings/intercom", json={"access_token": "intercom_secret_value"})
        assert r.status_code == 201
        body = r.json()
        assert body == {"connected": True}
        assert "access_token" not in body
        assert "access_token_encrypted" not in body

    row = (
        await db_session.execute(select(IntercomConnection).where(IntercomConnection.org_id == org_a))
    ).scalar_one()
    assert row.access_token_encrypted != "intercom_secret_value"

    from gnt.intercom.crypto import decrypt_token

    assert decrypt_token(row.access_token_encrypted) == "intercom_secret_value"


async def test_reconnect_upserts_rather_than_duplicating(admin_session, db_session, org_a, _fake_verify):
    async with admin_session as client:
        first = await client.post("/v1/settings/intercom", json={"access_token": "tok1"})
        assert first.status_code == 201

        second = await client.post("/v1/settings/intercom", json={"access_token": "tok2"})
        assert second.status_code == 201

    rows = (
        await db_session.execute(select(IntercomConnection).where(IntercomConnection.org_id == org_a))
    ).scalars().all()
    assert len(rows) == 1

    from gnt.intercom.crypto import decrypt_token

    assert decrypt_token(rows[0].access_token_encrypted) == "tok2"


async def test_get_connection_reports_not_connected_when_none_exists(admin_session):
    async with admin_session as client:
        r = await client.get("/v1/settings/intercom")
        assert r.status_code == 200
        assert r.json() == {"connected": False}


async def test_disconnect_removes_the_connection(admin_session, _fake_verify):
    async with admin_session as client:
        connect = await client.post("/v1/settings/intercom", json={"access_token": "tok"})
        assert connect.status_code == 201

        delete = await client.delete("/v1/settings/intercom")
        assert delete.status_code == 204

        after = await client.get("/v1/settings/intercom")
        assert after.json() == {"connected": False}


async def test_disconnect_404s_when_nothing_connected(admin_session):
    async with admin_session as client:
        r = await client.delete("/v1/settings/intercom")
        assert r.status_code == 404


async def test_disconnect_requires_admin(member_session):
    async with member_session as client:
        r = await client.delete("/v1/settings/intercom")
        assert r.status_code == 403


async def test_sync_status_reports_never_synced_before_any_run(admin_session):
    async with admin_session as client:
        r = await client.get("/v1/settings/intercom/sync-status")
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
    from gnt.intercom_sync_status import record_sync_result

    await ensure_org(db_session, org_a)
    await db_session.commit()
    await record_sync_result(
        db_session, org_a, ok=True, error=None, items_scanned=12, candidates_proposed=3
    )

    async with admin_session as client:
        r = await client.get("/v1/settings/intercom/sync-status")
        body = r.json()
        assert body["last_error"] is None
        assert body["items_scanned_last_run"] == 12
        assert body["candidates_proposed_last_run"] == 3
        assert body["last_success_at"] is not None
        assert body["last_synced_at"] is not None

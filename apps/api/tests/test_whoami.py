"""GET /v1/whoami -- lets apps/web's CLI-facing org routes resolve a
cli-key to an org id without duplicating key resolution logic. Admin-only
(same gate as every other org-management action), and never returns a
user_id (a cli-key carries no real Better Auth identity of its own)."""

from gnt.routers import settings as settings_router
from tests.conftest import make_org_client


async def test_whoami_returns_org_and_role_for_an_admin(test_app_factory, org_a):
    client = make_org_client(
        test_app_factory, org_a, user_id="admin_a", role="admin", routers=[settings_router.router]
    )
    async with client as c:
        r = await c.get("/v1/whoami")
    assert r.status_code == 200
    body = r.json()
    assert body == {"org_id": org_a, "role": "admin"}


async def test_whoami_refuses_a_non_admin_member(test_app_factory, org_a):
    client = make_org_client(
        test_app_factory, org_a, user_id="member_a", role="member", routers=[settings_router.router]
    )
    async with client as c:
        r = await c.get("/v1/whoami")
    assert r.status_code == 403

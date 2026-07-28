"""Product tester report: `gnt status` (GET /v1/brain/summary's mcp_key_exists)
and `gnt keys list` (GET /v1/settings/mcp-keys) disagreed about whether an org
has an MCP key. Root cause: brain_summary counted every mcp_api_keys row for
the org regardless of key_type or revocation, while list_mcp_keys has always
filtered to key_type == "mcp" only. Every org has a key_type == "cli" row
from `gnt login` alone, so mcp_key_exists was true for orgs `gnt keys list`
correctly shows as empty. This suite pins the fixed predicate: same
key_type == "mcp" filter as list_mcp_keys, plus excluding revoked keys since
a revoked key isn't something an agent can actually use.
"""

from gnt.auth.mcp_keys import generate_key
from gnt.db.models import McpApiKey
from gnt.db.org import ensure_org
from tests.conftest import make_org_client


async def _insert_key(db_session, org_id: str, *, key_type: str, revoked: bool = False) -> None:
    await ensure_org(db_session, org_id)
    _, key_hash = generate_key()
    key = McpApiKey(org_id=org_id, key_hash=key_hash, key_type=key_type)
    if revoked:
        from datetime import datetime, timezone

        key.revoked_at = datetime.now(timezone.utc)
    db_session.add(key)
    await db_session.commit()


async def test_mcp_key_exists_is_false_for_an_org_with_only_a_cli_key(
    test_app_factory, db_session, org_a
):
    """`gnt login` mints a key_type == "cli" row for every org -- that alone
    must not make brain_summary claim an MCP key exists, matching
    `gnt keys list` (key_type == "mcp" only) staying empty for the same org."""
    await _insert_key(db_session, org_a, key_type="cli")

    from gnt.routers import brain as brain_router

    async with make_org_client(test_app_factory, org_a, routers=[brain_router.router]) as client:
        r = await client.get("/v1/brain/summary")
        assert r.status_code == 200
        assert r.json()["mcp_key_exists"] is False


async def test_mcp_key_exists_is_false_when_the_only_mcp_key_is_revoked(
    test_app_factory, db_session, org_a
):
    await _insert_key(db_session, org_a, key_type="mcp", revoked=True)

    from gnt.routers import brain as brain_router

    async with make_org_client(test_app_factory, org_a, routers=[brain_router.router]) as client:
        r = await client.get("/v1/brain/summary")
        assert r.status_code == 200
        assert r.json()["mcp_key_exists"] is False


async def test_mcp_key_exists_is_true_for_a_live_mcp_key(test_app_factory, db_session, org_a):
    await _insert_key(db_session, org_a, key_type="mcp")

    from gnt.routers import brain as brain_router

    async with make_org_client(test_app_factory, org_a, routers=[brain_router.router]) as client:
        r = await client.get("/v1/brain/summary")
        assert r.status_code == 200
        assert r.json()["mcp_key_exists"] is True

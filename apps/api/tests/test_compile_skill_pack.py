"""compile_skill_pack (behind `gnt pull`) used to read approved rules from
the decision_rules table. That table went read-only when the old
dashboard-driven ingest path was retired -- nothing writes to it anymore
(see docs/migration/GIT_NATIVE_DONE.md). Approved rules now live in
apps/store's git-native engine, reached the same way routers/rules.py
reaches it: gnt.store_client against the real store subprocess this test
session already spawns (see conftest.py's `_store_process` fixture).
"""

import uuid

import pytest
from sqlalchemy import select

from gnt.approval import hash_approval_content, sign_approval
from gnt.compiler.pack import compile_skill_pack
from gnt.db.models import SkillFile
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.store_client import get_rule as store_get_rule
from gnt.store_client import put_rule
from tests.conftest import make_org_client


async def _create_and_submit(client, title: str, body: str, tags: list[str] | None = None) -> str:
    r = await client.post("/v1/rules", json={"title": title, "body": body, "tags": tags or []})
    assert r.status_code == 201
    rule_id = r.json()["id"]
    r = await client.post(f"/v1/rules/{rule_id}/submit")
    assert r.status_code == 200
    return rule_id


@pytest.fixture
def org_a() -> str:
    # A fresh id per test, not conftest's shared "org_test_a" -- the store
    # subprocess (apps/store, pglite) persists rules for the whole test
    # session, unlike db_session's per-test transaction rollback, so a
    # shared org id here would leak rules from one test's assertions into
    # the next's rule_count/rule_tags checks.
    return f"org_test_pack_{uuid.uuid4().hex[:8]}"


@pytest.fixture
def org_b() -> str:
    return f"org_test_pack_{uuid.uuid4().hex[:8]}"


async def _approve_directly_via_store(org_id: str, rule: dict) -> None:
    """Same shortcut test_rules.py uses -- approval now means a human
    merging a real GitHub PR, which the webhook confirms; there's no HTTP
    path to "approved" for a test to drive directly anymore."""
    rule = dict(rule)
    rule["status"] = "approved"
    rule["approvedBy"] = "admin_a"
    rule["approvedAt"] = "2026-07-14T00:00:00Z"
    content_hash = hash_approval_content(
        title=rule["title"], body=rule["body"], tags=rule["tags"], status=rule["status"]
    )
    signature = sign_approval(
        org_id=org_id, slug=rule["slug"], version=rule["version"], content_hash=content_hash
    )
    await put_rule(rule, approval_signature=signature)


async def test_compile_skill_pack_renders_approved_rules_by_tag(db_session, test_app_factory, org_a):
    admin_a = make_org_client(test_app_factory, org_a, user_id="admin_a", role="admin")
    async with admin_a as client:
        rule_id = await _create_and_submit(
            client, "Refund window", "Refunds within 30 days.", tags=["refunds"]
        )
        rule = await store_get_rule(org_a, f"rules/{rule_id}")
        await _approve_directly_via_store(org_a, rule)

    await scope_to_org(db_session, org_a)
    pack = await compile_skill_pack(db_session, org_a)

    assert pack.manifest["rule_count"] == 1
    assert pack.manifest["rule_tags"] == ["refunds"]

    files_result = await db_session.execute(select(SkillFile).where(SkillFile.pack_id == pack.id))
    files_by_path = {f.path: f.content for f in files_result.scalars()}

    assert "skills/rules/refunds/SKILL.md" in files_by_path
    rule_content = files_by_path["skills/rules/refunds/SKILL.md"]
    assert "Refund window" in rule_content
    assert "Refunds within 30 days." in rule_content

    assert "skills/rules/refunds/SKILL.md" in files_by_path["SKILL.md"]


async def test_compile_skill_pack_untagged_rule_falls_back_to_general(
    db_session, test_app_factory, org_a
):
    admin_a = make_org_client(test_app_factory, org_a, user_id="admin_a", role="admin")
    async with admin_a as client:
        rule_id = await _create_and_submit(client, "Escalation contact", "Ping #oncall.")
        rule = await store_get_rule(org_a, f"rules/{rule_id}")
        await _approve_directly_via_store(org_a, rule)

    await scope_to_org(db_session, org_a)
    pack = await compile_skill_pack(db_session, org_a)

    assert pack.manifest["rule_tags"] == ["general"]


async def test_compile_skill_pack_ignores_pending_and_draft_rules(
    db_session, test_app_factory, org_a
):
    admin_a = make_org_client(test_app_factory, org_a, user_id="admin_a", role="admin")
    async with admin_a as client:
        await _create_and_submit(client, "Draft only", "Never approved.", tags=["misc"])

    await scope_to_org(db_session, org_a)
    pack = await compile_skill_pack(db_session, org_a)

    assert pack.manifest["rule_count"] == 0
    assert pack.manifest["rule_tags"] == []


async def test_compile_skill_pack_scopes_rules_by_org(db_session, test_app_factory, org_a, org_b):
    admin_a = make_org_client(test_app_factory, org_a, user_id="admin_a", role="admin")
    async with admin_a as client:
        rule_id = await _create_and_submit(client, "Org A only", "Only for org A.", tags=["misc"])
        rule = await store_get_rule(org_a, f"rules/{rule_id}")
        await _approve_directly_via_store(org_a, rule)

    await ensure_org(db_session, org_b)
    await db_session.commit()
    await scope_to_org(db_session, org_b)
    pack_b = await compile_skill_pack(db_session, org_b)

    assert pack_b.manifest["rule_count"] == 0

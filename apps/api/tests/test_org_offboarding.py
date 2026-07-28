"""fix-plan-v3 tier 0 item 0.3 (C4) — org offboarding.

Covers the two non-negotiables the plan calls out explicitly: a non-admin
(and an admin-snapshotted API key) can never kick this off, and an org can
never delete an org it doesn't belong to. Plus the mechanics: the
confirmation gate genuinely requires two calls (a bare confirm with no
prior request, and a confirm with a wrong/reused token, both fail), the
export reflects exactly what's about to be deleted, and the delete itself
actually empties every org-scoped table (queried individually, not just
trusted from a summary count) plus the store-side rules mirror — while
leaving a second org's data completely untouched.
"""

import uuid
from datetime import date, datetime, timezone

import pytest
from sqlalchemy import select

from gnt.db.models import (
    CalibrationEvent,
    ContradictionFinding,
    GithubConnection,
    IngestEvent,
    McpApiKey,
    OnboardingEvent,
    Rule,
    RuleAuditLog,
    RuleGap,
    RuleStaleness,
    RoiCounter,
    SkillFile,
    SkillPack,
    SlackConnection,
    WebhookToken,
)
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.github.crypto import encrypt_token
from gnt.slack.crypto import encrypt_token as encrypt_slack_token
from gnt.store_client import get_rule as store_get_rule
from tests.conftest import make_org_client


@pytest.fixture
def offboarding_routers():
    from gnt.routers import org_admin as org_admin_router
    from gnt.routers import rules as rules_router

    return [rules_router.router, org_admin_router.router]


def _unique_org(prefix: str) -> str:
    return f"org_test_{prefix}_{uuid.uuid4().hex[:8]}"


async def _seed_full_org(db_session, org_id: str) -> None:
    """Inserts one row into every org-scoped Postgres table (the full
    authoritative list from db/models.py), plus a real store-side rule via
    a direct put_rule call (cheaper than round-tripping through the
    router for seeding purposes) — everything this item's deletion logic
    is supposed to touch."""
    from gnt.store_client import append_audit, put_rule

    await ensure_org(db_session, org_id)
    await db_session.commit()
    await scope_to_org(db_session, org_id)

    rule_slug = f"rules/{uuid.uuid4()}"
    now = datetime.now(timezone.utc).isoformat()
    rule = {
        "slug": rule_slug,
        "org": org_id,
        "title": "Seed rule",
        "body": "Seed body.",
        "status": "draft",
        "confidence": 0.7,
        "ownerId": "seed_user",
        "sourceCitations": [],
        "source": None,
        "tags": [],
        "lastValidatedAt": None,
        "version": 1,
        "supersededBy": None,
        "previousVersionId": None,
        "approvedBy": None,
        "approvedAt": None,
        "createdAt": now,
        "prNumber": None,
        "prUrl": None,
    }
    await put_rule(rule)
    await append_audit(
        org_id=org_id,
        rule_slug=rule_slug,
        actor_id="seed_user",
        action="created",
        before=None,
        after=rule,
    )

    db_session.add(RuleGap(org_id=org_id, tool="search_rules", query_text="seed gap"))
    db_session.add(
        RuleStaleness(
            org_id=org_id,
            rule_slug="rules/legacy-1",
            title="Legacy rule",
            age_days=10.0,
            freshness_score=0.5,
            is_stale=True,
        )
    )
    db_session.add(CalibrationEvent(org_id=org_id, event_type="rule_deprecated", age_days=5.0))
    db_session.add(
        ContradictionFinding(
            org_id=org_id,
            rule_slug_a="rules/a",
            rule_slug_b="rules/b",
            relation="contradicts",
            issue_number=1,
            issue_url="https://github.com/acme/rules/issues/1",
        )
    )
    db_session.add(RoiCounter(org_id=org_id, day=date.today(), rules_served=3))
    db_session.add(OnboardingEvent(org_id=org_id, event_type="rule_proposed"))
    db_session.add(McpApiKey(org_id=org_id, key_hash=f"hash-{uuid.uuid4()}", name="seed-key"))
    db_session.add(WebhookToken(org_id=org_id, token_hash=f"hash-{uuid.uuid4()}", name="seed-token"))
    db_session.add(IngestEvent(org_id=org_id, source="upload", contributor_hash="seed-hash"))
    db_session.add(
        SlackConnection(
            org_id=org_id,
            team_id=f"T{uuid.uuid4().hex[:8]}",
            team_name="Seed Workspace",
            bot_user_id="U0SEED",
            bot_token_encrypted=encrypt_slack_token("fake-slack-token"),
            scope="commands,chat:write",
            installed_by_user_id="seed_user",
        )
    )
    db_session.add(
        GithubConnection(
            org_id=org_id,
            repo_url=f"https://github.com/acme/{org_id}",
            default_branch="main",
            pat_encrypted=encrypt_token("fake-pat"),
            webhook_secret_encrypted=encrypt_token("fake-webhook-secret"),
            installed_by_user_id="seed_user",
        )
    )
    legacy_rule_id = uuid.uuid4()
    db_session.add(
        Rule(
            id=legacy_rule_id,
            org_id=org_id,
            title="Legacy pg rule",
            body="Pre-migration content.",
            owner_user_id="seed_user",
        )
    )
    db_session.add(
        RuleAuditLog(
            org_id=org_id,
            rule_id=legacy_rule_id,
            action="created",
            actor_user_id="seed_user",
            after={"title": "Legacy pg rule"},
        )
    )
    pack = SkillPack(org_id=org_id, version=1, manifest={})
    db_session.add(pack)
    await db_session.flush()
    db_session.add(SkillFile(pack_id=pack.id, path="skill.md", content="# seed", sha256="deadbeef"))

    await db_session.commit()


async def _row_count(db_session, org_id, model) -> int:
    await scope_to_org(db_session, org_id)
    rows = (await db_session.execute(select(model).where(model.org_id == org_id))).scalars().all()
    return len(rows)


@pytest.fixture
def admin_a(test_app_factory, org_a, offboarding_routers):
    return make_org_client(test_app_factory, org_a, user_id="admin_a", role="admin", routers=offboarding_routers)


@pytest.fixture
def member_a(test_app_factory, org_a, offboarding_routers):
    return make_org_client(test_app_factory, org_a, user_id="member_a", role=None, routers=offboarding_routers)


@pytest.fixture
def api_key_admin_a(test_app_factory, org_a, offboarding_routers):
    """An admin-snapshotted API key — require_admin_session must refuse
    this the same way require_session refuses it for create_cli_key,
    regardless of the is_admin snapshot."""
    return make_org_client(
        test_app_factory,
        org_a,
        user_id="api-key",
        role="admin",
        auth_kind="api_key",
        routers=offboarding_routers,
    )


@pytest.fixture
def admin_b(test_app_factory, org_b, offboarding_routers):
    return make_org_client(test_app_factory, org_b, user_id="admin_b", role="admin", routers=offboarding_routers)


# -- auth gating ----------------------------------------------------------


async def test_request_rejects_non_admin(member_a):
    async with member_a as client:
        r = await client.post("/v1/org/offboarding/request")
        assert r.status_code == 403


async def test_request_rejects_api_key_even_when_admin_snapshotted(api_key_admin_a):
    async with api_key_admin_a as client:
        r = await client.post("/v1/org/offboarding/request")
        assert r.status_code == 403


async def test_confirm_rejects_non_admin(member_a):
    async with member_a as client:
        r = await client.post("/v1/org/offboarding/confirm", json={"confirmation_token": "whatever"})
        assert r.status_code == 403


async def test_confirm_rejects_api_key_even_when_admin_snapshotted(api_key_admin_a):
    async with api_key_admin_a as client:
        r = await client.post("/v1/org/offboarding/confirm", json={"confirmation_token": "whatever"})
        assert r.status_code == 403


# -- confirmation gate: a bare single-call delete does not work -----------


async def test_confirm_without_a_prior_request_is_refused(test_app_factory, offboarding_routers):
    org_id = _unique_org("bare")
    client = make_org_client(test_app_factory, org_id, user_id="admin", role="admin", routers=offboarding_routers)
    async with client as c:
        r = await c.post("/v1/org/offboarding/confirm", json={"confirmation_token": "not-a-real-token"})
        assert r.status_code == 400


async def test_confirm_rejects_a_wrong_token(admin_a):
    async with admin_a as client:
        requested = await client.post("/v1/org/offboarding/request")
        assert requested.status_code == 200

        wrong = await client.post(
            "/v1/org/offboarding/confirm", json={"confirmation_token": "definitely-wrong"}
        )
        assert wrong.status_code == 400


async def test_confirm_is_single_use(db_session, org_a, admin_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    async with admin_a as client:
        requested = await client.post("/v1/org/offboarding/request")
        token = requested.json()["confirmation_token"]

        first = await client.post("/v1/org/offboarding/confirm", json={"confirmation_token": token})
        assert first.status_code == 200

        second = await client.post("/v1/org/offboarding/confirm", json={"confirmation_token": token})
        assert second.status_code == 400


# -- cross-org isolation: the plan's own automatic-rejection non-negotiable


async def test_confirm_refuses_another_orgs_token(db_session, org_a, org_b, admin_a, admin_b):
    """org_b must not be able to use org_a's confirmation token to delete
    org_b (or anything) — and the mismatch must not burn org_a's own,
    still-valid token."""
    await ensure_org(db_session, org_a)
    await db_session.commit()

    async with admin_a as client_a:
        requested = await client_a.post("/v1/org/offboarding/request")
        token_a = requested.json()["confirmation_token"]

        async with admin_b as client_b:
            cross_org_attempt = await client_b.post(
                "/v1/org/offboarding/confirm", json={"confirmation_token": token_a}
            )
            assert cross_org_attempt.status_code == 400

        # org_a's real token must still work — the failed cross-org attempt
        # was scoped to org_b's own (empty) redis key and never touched it.
        real_confirm = await client_a.post(
            "/v1/org/offboarding/confirm", json={"confirmation_token": token_a}
        )
        assert real_confirm.status_code == 200


# -- export reflects what's about to be deleted ----------------------------


async def test_export_contains_the_seeded_data(db_session, test_app_factory, offboarding_routers):
    # A fresh, uuid-suffixed org rather than the shared org_a fixture: this
    # test writes a real rule into apps/store's session-scoped store and
    # never deletes it, so reusing org_a would leak a stray rule into
    # whichever later test also seeds org_a — see conftest.py's own note on
    # why store-touching tests use per-test-unique org ids.
    org_id = _unique_org("export")
    client = make_org_client(test_app_factory, org_id, user_id="admin", role="admin", routers=offboarding_routers)
    await _seed_full_org(db_session, org_id)

    async with client as c:
        r = await c.post("/v1/org/offboarding/request")
        assert r.status_code == 200
        export = r.json()["export"]

    assert export["org_id"] == org_id
    assert len(export["rules"]) == 1
    assert export["rules"][0]["title"] == "Seed rule"
    assert len(export["rules"][0]["audit_trail"]) == 1
    assert len(export["rule_gaps"]) == 1
    assert len(export["rule_staleness"]) == 1
    assert len(export["calibration_events"]) == 1
    assert len(export["contradiction_findings"]) == 1
    assert len(export["roi_counters"]) == 1
    assert export["roi_counters"][0]["rules_served"] == 3
    assert len(export["onboarding_events"]) == 1
    assert len(export["mcp_api_keys"]) == 1
    assert len(export["webhook_tokens"]) == 1
    assert export["slack_connection"]["team_name"] == "Seed Workspace"
    assert export["github_connection"]["repo_url"] == f"https://github.com/acme/{org_id}"

    # Never a secret, in any form — the whole point of exporting metadata
    # only.
    dumped = str(export)
    assert "fake-pat" not in dumped
    assert "fake-webhook-secret" not in dumped
    assert "fake-slack-token" not in dumped


# -- the actual deletion: every table, queried individually ---------------


async def test_confirm_deletes_every_org_scoped_table_and_the_store_mirror(
    db_session, test_app_factory, offboarding_routers
):
    # Fresh, uuid-suffixed orgs — same reasoning as
    # test_export_contains_the_seeded_data: these tests write real rules
    # into apps/store's session-scoped store, so reusing the shared
    # org_a/org_b fixtures would collide with rules other tests in this
    # module leave behind for those same org ids.
    org_a = _unique_org("delete_a")
    org_b = _unique_org("delete_b")
    admin_a = make_org_client(test_app_factory, org_a, user_id="admin_a", role="admin", routers=offboarding_routers)

    await _seed_full_org(db_session, org_a)
    await _seed_full_org(db_session, org_b)

    async with admin_a as client:
        requested = await client.post("/v1/org/offboarding/request")
        rule_slug = requested.json()["export"]["rules"][0]["slug"]
        token = requested.json()["confirmation_token"]

        confirmed = await client.post("/v1/org/offboarding/confirm", json={"confirmation_token": token})
        assert confirmed.status_code == 200
        body = confirmed.json()

    # Every table the response claims to have touched actually reflects
    # rows that existed — this is the "don't just trust the summary"
    # check the plan calls for.
    expected_tables = {
        "skill_files",
        "rule_audit_log",
        "rules",
        "skill_packs",
        "ingest_events",
        "onboarding_events",
        "rule_gaps",
        "rule_staleness",
        "calibration_events",
        "contradiction_findings",
        "roi_counters",
        "mcp_api_keys",
        "webhook_tokens",
        "slack_connections",
        "github_connections",
    }
    assert set(body["postgres"].keys()) == expected_tables
    for table, count in body["postgres"].items():
        assert count == 1, f"expected exactly 1 row deleted from {table}, got {count}"
    assert body["store"]["pagesDeleted"] == 1

    # Query every table directly for org_a — zero rows left, not just a
    # count that happens to match what the response claimed.
    for model in (
        RuleGap,
        RuleStaleness,
        CalibrationEvent,
        ContradictionFinding,
        RoiCounter,
        OnboardingEvent,
        McpApiKey,
        WebhookToken,
        IngestEvent,
        SlackConnection,
        GithubConnection,
        Rule,
        RuleAuditLog,
        SkillPack,
    ):
        assert await _row_count(db_session, org_a, model) == 0, f"{model.__name__} still has rows for org_a"

    await scope_to_org(db_session, org_a)
    remaining_skill_files = (
        await db_session.execute(
            select(SkillFile).where(
                SkillFile.pack_id.in_(select(SkillPack.id).where(SkillPack.org_id == org_a))
            )
        )
    ).scalars().all()
    assert remaining_skill_files == []

    # The store-side rules mirror is actually gone, not just marked
    # deleted in Postgres — a direct call against the real store server.
    assert await store_get_rule(org_a, rule_slug) is None

    # org_b's identically-seeded data is completely untouched.
    for model in (
        RuleGap,
        RuleStaleness,
        CalibrationEvent,
        ContradictionFinding,
        RoiCounter,
        OnboardingEvent,
        McpApiKey,
        WebhookToken,
        IngestEvent,
        SlackConnection,
        GithubConnection,
        Rule,
        RuleAuditLog,
        SkillPack,
    ):
        assert await _row_count(db_session, org_b, model) == 1, f"{model.__name__} lost org_b's row"

"""onboarding_events (fix-plan-v2 item 6 — first-session success
instrumentation). Covers: log_onboarding_event writes a real row and is
genuinely best-effort (a failure never raises out to the caller), RLS
actually isolates one org's events from another's at the database level
(mirrors test_compile_skill_pack.py's org-scoping pattern), and
/v1/onboarding/status aggregates and scopes correctly.
"""

from sqlalchemy import select

from gnt.db.models import McpApiKey, OnboardingEvent
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.onboarding_metrics import log_onboarding_event
from gnt.routers import brain as brain_router
from tests.conftest import make_org_client


async def test_log_onboarding_event_writes_row(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    await log_onboarding_event(db_session, org_a, "rule_proposed")

    await scope_to_org(db_session, org_a)
    rows = (
        await db_session.execute(select(OnboardingEvent).where(OnboardingEvent.org_id == org_a))
    ).scalars().all()
    assert len(rows) == 1
    assert rows[0].event_type == "rule_proposed"


async def test_log_onboarding_event_swallows_failures(db_session, org_a, monkeypatch):
    """An unknown event_type trips the helper's internal assertion --
    proof that even a bug inside the helper itself can't escape and break
    whatever request it's riding along in."""
    captured: list[Exception] = []
    monkeypatch.setattr(
        "gnt.onboarding_metrics.sentry_sdk.capture_exception", lambda exc: captured.append(exc)
    )

    await ensure_org(db_session, org_a)
    await db_session.commit()

    await log_onboarding_event(db_session, org_a, "not_a_real_event_type")

    assert len(captured) == 1
    await scope_to_org(db_session, org_a)
    rows = (
        await db_session.execute(select(OnboardingEvent).where(OnboardingEvent.org_id == org_a))
    ).scalars().all()
    assert rows == []


async def test_onboarding_events_are_org_isolated_by_rls(db_session, org_a, org_b):
    await ensure_org(db_session, org_a)
    await ensure_org(db_session, org_b)
    await db_session.commit()

    await log_onboarding_event(db_session, org_a, "rule_approved")

    # Scoped as org_b, org_a's row must be invisible even though the query
    # itself doesn't filter by org_id -- this is the RLS policy doing the
    # filtering, not application code.
    await scope_to_org(db_session, org_b)
    org_b_view = (await db_session.execute(select(OnboardingEvent))).scalars().all()
    assert org_b_view == []

    # Scoped back to org_a, the row is visible again.
    await scope_to_org(db_session, org_a)
    org_a_view = (await db_session.execute(select(OnboardingEvent))).scalars().all()
    assert len(org_a_view) == 1
    assert org_a_view[0].org_id == org_a


async def test_onboarding_status_aggregates_counts(db_session, test_app_factory, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    for event_type in ("slack_connected", "rule_proposed", "rule_proposed", "rule_approved"):
        await log_onboarding_event(db_session, org_a, event_type)

    client = make_org_client(test_app_factory, org_a, routers=[brain_router.router])
    async with client:
        r = await client.get("/v1/onboarding/status")
    assert r.status_code == 200
    assert r.json() == {
        "connected_cli": False,
        "connected_slack": True,
        "connected_github": False,
        "github_needs_upgrade": False,
        "rules_proposed": 2,
        "rules_approved": 1,
        "reached_five_rules_milestone": False,
    }


async def test_onboarding_status_is_scoped_to_current_org(db_session, test_app_factory, org_a, org_b):
    await ensure_org(db_session, org_a)
    await ensure_org(db_session, org_b)
    await db_session.commit()

    await log_onboarding_event(db_session, org_a, "rule_proposed")

    client_b = make_org_client(test_app_factory, org_b, routers=[brain_router.router])
    async with client_b:
        r = await client_b.get("/v1/onboarding/status")
    assert r.status_code == 200
    assert r.json() == {
        "connected_cli": False,
        "connected_slack": False,
        "connected_github": False,
        "github_needs_upgrade": False,
        "rules_proposed": 0,
        "rules_approved": 0,
        "reached_five_rules_milestone": False,
    }


async def test_onboarding_status_reports_five_rule_milestone(db_session, test_app_factory, org_a):
    """fix-plan-v3 2.6's success metric: reached_five_rules_milestone flips
    True the moment rules_approved hits RULES_APPROVED_MILESTONE (5), and
    not a single event before that."""
    await ensure_org(db_session, org_a)
    await db_session.commit()

    for _ in range(4):
        await log_onboarding_event(db_session, org_a, "rule_approved")

    client = make_org_client(test_app_factory, org_a, routers=[brain_router.router])
    async with client:
        r = await client.get("/v1/onboarding/status")
        assert r.json()["rules_approved"] == 4
        assert r.json()["reached_five_rules_milestone"] is False

        await log_onboarding_event(db_session, org_a, "rule_approved")

        r = await client.get("/v1/onboarding/status")
        assert r.json()["rules_approved"] == 5
        assert r.json()["reached_five_rules_milestone"] is True


async def test_onboarding_status_connected_cli_reads_mcp_api_keys(
    db_session, test_app_factory, org_a, org_b
):
    """connected_cli isn't an onboarding_event -- it's read straight off
    mcp_api_keys (see brain.py's onboarding_status comment). A non-CLI
    (key_type="mcp") key must NOT flip it, and a CLI key minted for a
    different org must not leak across -- mirrors
    test_onboarding_status_is_scoped_to_current_org's isolation check but
    for this specific signal's own query, not the RLS-backed one."""
    await ensure_org(db_session, org_a)
    await ensure_org(db_session, org_b)
    db_session.add(McpApiKey(org_id=org_a, key_hash="mcp-key-org-a", key_type="mcp"))
    db_session.add(McpApiKey(org_id=org_b, key_hash="cli-key-org-b", key_type="cli"))
    await db_session.commit()

    client_a = make_org_client(test_app_factory, org_a, routers=[brain_router.router])
    async with client_a:
        r = await client_a.get("/v1/onboarding/status")
    assert r.json()["connected_cli"] is False

    client_b = make_org_client(test_app_factory, org_b, routers=[brain_router.router])
    async with client_b:
        r = await client_b.get("/v1/onboarding/status")
    assert r.json()["connected_cli"] is True

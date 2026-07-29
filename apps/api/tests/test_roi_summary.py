"""gnt.roi_summary.build_roi_summary and GET /v1/roi/summary — the one
aggregation both the weekly digest and `gnt status` read from, see
roi_summary.py's own module docstring for why there's exactly one
definition of "this week vs. last week" rather than two."""

from datetime import date, datetime, time, timedelta, timezone

from gnt.db.models import RuleGap
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.roi_metrics import bump_roi_counters
from gnt.roi_summary import build_roi_summary
from gnt.routers import roi as roi_router
from tests.conftest import make_org_client


async def test_build_roi_summary_combines_roi_gaps_and_staleness(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()
    await scope_to_org(db_session, org_a)

    await bump_roi_counters(db_session, org_a, {"rules_served": 5, "actions_checked": 3, "actions_needs_human": 1})
    db_session.add(RuleGap(org_id=org_a, tool="search_rules", query_text="uncovered"))
    await db_session.commit()

    summary = await build_roi_summary(db_session, org_a)

    assert summary["roi"]["current"]["rules_served"] == 5
    assert summary["roi"]["current"]["actions_checked"] == 3
    assert summary["roi"]["current"]["actions_needs_human"] == 1
    assert summary["gaps"]["current"] == 1
    assert summary["gaps"]["prior"] == 0
    assert summary["stale_due_count"] == 0


async def test_build_roi_summary_gap_window_excludes_gaps_outside_the_window(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()
    await scope_to_org(db_session, org_a)

    long_ago = date.today() - timedelta(days=60)
    db_session.add(
        RuleGap(
            org_id=org_a,
            tool="search_rules",
            query_text="old",
            created_at=datetime.combine(long_ago, time.min, tzinfo=timezone.utc),
        )
    )
    await db_session.commit()

    summary = await build_roi_summary(db_session, org_a)

    assert summary["gaps"]["current"] == 0
    assert summary["gaps"]["prior"] == 0


async def test_get_roi_summary_endpoint_is_scoped_to_current_org(db_session, test_app_factory, org_a, org_b):
    await ensure_org(db_session, org_a)
    await ensure_org(db_session, org_b)
    await db_session.commit()

    await bump_roi_counters(db_session, org_a, {"rules_served": 7})

    client_b = make_org_client(test_app_factory, org_b, routers=[roi_router.router])
    async with client_b:
        r = await client_b.get("/v1/roi/summary")
    assert r.status_code == 200
    body_b = r.json()
    assert body_b["rules_served"] == 0

    client_a = make_org_client(test_app_factory, org_a, routers=[roi_router.router])
    async with client_a:
        r = await client_a.get("/v1/roi/summary")
    assert r.status_code == 200
    body_a = r.json()
    assert body_a["rules_served"] == 7
    assert body_a["window_days"] == 7
    assert "gap_count" in body_a
    assert "stale_due_count" in body_a

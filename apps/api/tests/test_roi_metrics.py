"""roi_counters / roi_metrics.py (ROI metering and the weekly number).
Covers: bump_roi_counters upserts and genuinely
increments (not overwrites) an existing day's row, bumping several
counters in one call only touches those columns, an unknown counter name
is swallowed the same best-effort way gap_tracking.log_gap swallows an
unknown tool, RLS actually isolates one org's counters from another's, and
summary_for_window sums the right two non-overlapping trailing windows."""

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select

from gnt.db.models import RoiCounter
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.roi_metrics import bump_roi_counters, summary_for_window


async def test_bump_roi_counters_creates_a_new_days_row(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    await bump_roi_counters(db_session, org_a, {"rules_served": 3})

    await scope_to_org(db_session, org_a)
    row = (await db_session.execute(select(RoiCounter).where(RoiCounter.org_id == org_a))).scalar_one()
    assert row.rules_served == 3
    assert row.actions_checked == 0
    # UTC, not the local date — see roi_metrics.bump_roi_counters's own
    # comment on why this counter buckets by the UTC calendar date.
    assert row.day == datetime.now(timezone.utc).date()


async def test_bump_roi_counters_increments_an_existing_days_row(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    await bump_roi_counters(db_session, org_a, {"rules_served": 3})
    await bump_roi_counters(db_session, org_a, {"rules_served": 2})

    await scope_to_org(db_session, org_a)
    row = (await db_session.execute(select(RoiCounter).where(RoiCounter.org_id == org_a))).scalar_one()
    assert row.rules_served == 5


async def test_bump_roi_counters_bumps_multiple_columns_in_one_call(db_session, org_a):
    """check_action's own call site bumps actions_checked and (blocked or
    needs_human) together in a single upsert — proves that shape doesn't
    clobber the other column."""
    await ensure_org(db_session, org_a)
    await db_session.commit()

    await bump_roi_counters(db_session, org_a, {"actions_checked": 1, "actions_blocked": 1})

    await scope_to_org(db_session, org_a)
    row = (await db_session.execute(select(RoiCounter).where(RoiCounter.org_id == org_a))).scalar_one()
    assert row.actions_checked == 1
    assert row.actions_blocked == 1
    assert row.actions_needs_human == 0
    assert row.rules_served == 0


async def test_bump_roi_counters_empty_dict_is_a_no_op(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    await bump_roi_counters(db_session, org_a, {})

    await scope_to_org(db_session, org_a)
    rows = (await db_session.execute(select(RoiCounter).where(RoiCounter.org_id == org_a))).scalars().all()
    assert rows == []


async def test_bump_roi_counters_swallows_unknown_metric(db_session, org_a, monkeypatch):
    captured: list[Exception] = []
    monkeypatch.setattr("gnt.roi_metrics.sentry_sdk.capture_exception", lambda exc: captured.append(exc))

    await ensure_org(db_session, org_a)
    await db_session.commit()

    await bump_roi_counters(db_session, org_a, {"not_a_real_counter": 1})

    assert len(captured) == 1
    await scope_to_org(db_session, org_a)
    rows = (await db_session.execute(select(RoiCounter).where(RoiCounter.org_id == org_a))).scalars().all()
    assert rows == []


async def test_roi_counters_are_org_isolated_by_rls(db_session, org_a, org_b):
    await ensure_org(db_session, org_a)
    await ensure_org(db_session, org_b)
    await db_session.commit()

    await bump_roi_counters(db_session, org_a, {"rules_served": 1})

    await scope_to_org(db_session, org_b)
    org_b_view = (await db_session.execute(select(RoiCounter))).scalars().all()
    assert org_b_view == []

    await scope_to_org(db_session, org_a)
    org_a_view = (await db_session.execute(select(RoiCounter))).scalars().all()
    assert len(org_a_view) == 1


async def test_summary_for_window_sums_current_and_prior_trailing_windows(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    today = date(2026, 7, 20)  # a Monday, arbitrary fixed anchor
    # Current window: today and the 6 days before it (7 days total).
    for offset in range(7):
        await bump_roi_counters(
            db_session, org_a, {"rules_served": 1}, today=today - timedelta(days=offset)
        )
    # Prior window: the 7 days immediately before that.
    for offset in range(7, 14):
        await bump_roi_counters(
            db_session, org_a, {"rules_served": 10}, today=today - timedelta(days=offset)
        )
    # Well outside either window -- must not be counted in either sum.
    await bump_roi_counters(db_session, org_a, {"rules_served": 999}, today=today - timedelta(days=30))

    await scope_to_org(db_session, org_a)
    result = await summary_for_window(db_session, org_a, end=today, window_days=7)

    assert result["window_days"] == 7
    assert result["current"]["rules_served"] == 7
    assert result["prior"]["rules_served"] == 70


async def test_summary_for_window_is_org_isolated(db_session, org_a, org_b):
    await ensure_org(db_session, org_a)
    await ensure_org(db_session, org_b)
    await db_session.commit()

    await bump_roi_counters(db_session, org_a, {"rules_served": 5})
    await bump_roi_counters(db_session, org_b, {"rules_served": 9})

    await scope_to_org(db_session, org_a)
    result_a = await summary_for_window(db_session, org_a)
    assert result_a["current"]["rules_served"] == 5

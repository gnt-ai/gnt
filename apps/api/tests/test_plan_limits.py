"""gnt.plan_limits — the per-tier monthly check_action call cap (1500
base / 8000 pro), a different axis from llm_quota.py's dollar-based
quota. Reuses roi_counters.actions_checked as its count source rather
than a second counter table.

Every test pins a synthetic month (_MONTH, year 2099) for the same
cross-test-isolation reason test_llm_quota.py does — roi_counters rows
are genuinely global per org/day, not rolled back mid-test the way the
db_session transaction itself is for anything else."""

from datetime import date

import pytest

from gnt.db.models import Org
from gnt.db.org import ensure_org
from gnt.plan_limits import (
    MONTHLY_ACTION_CAP,
    PlanActionCapExceededError,
    cap_for_tier,
    check_plan_action_cap,
    enforce_plan_action_cap,
    get_plan_action_usage,
    org_plan_tier,
)
from gnt.roi_metrics import bump_roi_counters

_MONTH = date(2099, 3, 15)


def test_cap_for_tier_defaults_unknown_or_null_to_base():
    assert cap_for_tier(None) == MONTHLY_ACTION_CAP["base"]
    assert cap_for_tier("not-a-real-tier") == MONTHLY_ACTION_CAP["base"]
    assert cap_for_tier("pro") == MONTHLY_ACTION_CAP["pro"]


async def test_usage_defaults_to_zero_with_no_roi_counter_rows(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    used, cap = await get_plan_action_usage(org_a, today=_MONTH)
    assert used == 0
    assert cap == MONTHLY_ACTION_CAP["base"]
    assert await check_plan_action_cap(org_a, today=_MONTH) is True


async def test_pro_org_gets_the_pro_cap(db_session, org_a):
    await ensure_org(db_session, org_a)
    org = await db_session.get(Org, org_a)
    org.plan_tier = "pro"
    await db_session.commit()

    _, cap = await get_plan_action_usage(org_a, today=_MONTH)
    assert cap == MONTHLY_ACTION_CAP["pro"]


async def test_check_and_enforce_block_once_cap_reached(db_session, org_a, monkeypatch):
    monkeypatch.setitem(MONTHLY_ACTION_CAP, "base", 3)
    await ensure_org(db_session, org_a)
    await db_session.commit()

    await bump_roi_counters(db_session, org_a, {"actions_checked": 3}, today=_MONTH)

    assert await check_plan_action_cap(org_a, today=_MONTH) is False
    with pytest.raises(PlanActionCapExceededError, match="monthly check_action limit reached"):
        await enforce_plan_action_cap(org_a, today=_MONTH)


async def test_usage_sums_the_whole_calendar_month_not_just_one_day(db_session, org_a, monkeypatch):
    monkeypatch.setitem(MONTHLY_ACTION_CAP, "base", 100)
    await ensure_org(db_session, org_a)
    await db_session.commit()

    await bump_roi_counters(db_session, org_a, {"actions_checked": 4}, today=date(2099, 3, 1))
    await bump_roi_counters(db_session, org_a, {"actions_checked": 5}, today=date(2099, 3, 20))

    used, _ = await get_plan_action_usage(org_a, today=_MONTH)
    assert used == 9


async def test_a_prior_months_usage_does_not_carry_over(db_session, org_a, monkeypatch):
    monkeypatch.setitem(MONTHLY_ACTION_CAP, "base", 3)
    await ensure_org(db_session, org_a)
    await db_session.commit()

    await bump_roi_counters(db_session, org_a, {"actions_checked": 3}, today=date(2099, 2, 15))

    # A brand-new month's usage starts back at zero -- the February spike
    # above must not leak into March's cap check.
    assert await check_plan_action_cap(org_a, today=_MONTH) is True


async def test_tenant_isolation_org_b_not_blocked_by_org_as_exhausted_cap(
    db_session, org_a, org_b, monkeypatch
):
    monkeypatch.setitem(MONTHLY_ACTION_CAP, "base", 1)
    await ensure_org(db_session, org_a)
    await ensure_org(db_session, org_b)
    await db_session.commit()

    await bump_roi_counters(db_session, org_a, {"actions_checked": 1}, today=_MONTH)

    assert await check_plan_action_cap(org_a, today=_MONTH) is False
    assert await check_plan_action_cap(org_b, today=_MONTH) is True
    await enforce_plan_action_cap(org_b, today=_MONTH)  # must not raise


async def test_org_plan_tier_defaults_to_base_for_a_null_column(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    assert await org_plan_tier(db_session, org_a) == "base"

    org = await db_session.get(Org, org_a)
    org.plan_tier = "pro"
    await db_session.commit()

    assert await org_plan_tier(db_session, org_a) == "pro"

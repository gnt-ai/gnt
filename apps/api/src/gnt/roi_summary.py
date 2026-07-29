"""Shared ROI aggregation — the one place that
combines roi_counters (gnt.roi_metrics), rule_gaps (gnt.gap_tracking), and
rule_staleness (gnt.staleness) into the ROI numbers the product reports on:
rules served, actions checked, blocked/needs_human counts, gap
count, coverage growth. Both consumers of this data — GET /v1/roi/summary
(routers/roi.py, backing `gnt status`) and the weekly digest email
(workers/tasks_digest.py) — call build_roi_summary rather than each
re-deriving the same two trailing windows independently, so there's
exactly one definition of "this week" vs. "last week" to drift out of
sync.
"""

from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from gnt.gap_tracking import count_gaps_between
from gnt.roi_metrics import summary_for_window
from gnt.staleness import list_due_for_revalidation

WINDOW_DAYS = 7


async def build_roi_summary(
    session: AsyncSession, org_id: str, *, end: date | None = None, window_days: int = WINDOW_DAYS
) -> dict[str, Any]:
    """This org's aggregated ROI numbers: roi_counters summed over the
    current and prior `window_days`-day windows (roi_metrics.
    summary_for_window), rule_gaps counted over the same two windows
    (gap_tracking.count_gaps_between — the "coverage growth" signal), and
    the re-validation-due count from the nightly staleness sweep
    (gnt.staleness.list_due_for_revalidation) folded in per routers/rules.py's own docstring pointing
    that prompt at this digest once it existed. Assumes the caller has
    already scope_to_org'd `session` for `org_id` — summary_for_window/
    count_gaps_between/list_due_for_revalidation each re-scope it anyway
    (same "scope again" convention every helper in this codebase follows),
    so this is not itself an isolation boundary, just aggregation."""
    # UTC, not the server's local date — gap_tracking.count_gaps_between
    # (called below) anchors its window in explicit UTC datetimes against
    # RuleGap.created_at (a DateTime(timezone=True) column Postgres stamps
    # in UTC), so a local `date.today()` here on any server not itself
    # running in UTC would silently drop gap rows created after local
    # midnight but before UTC midnight (or the reverse) right out of the
    # "current" window — exactly the mismatch that broke this on a non-UTC
    # dev machine. summary_for_window below reads roi_counters.day, which
    # roi_metrics.bump_roi_counters now buckets by this same UTC date, so
    # both halves of this aggregation agree on what "today" means.
    end = end or datetime.now(timezone.utc).date()
    roi = await summary_for_window(session, org_id, end=end, window_days=window_days)

    current_start = end - timedelta(days=window_days - 1)
    prior_end = current_start - timedelta(days=1)
    prior_start = prior_end - timedelta(days=window_days - 1)
    gap_current = await count_gaps_between(session, org_id, current_start, end)
    gap_prior = await count_gaps_between(session, org_id, prior_start, prior_end)

    stale = await list_due_for_revalidation(session, org_id, limit=1)

    return {
        "roi": roi,
        "gaps": {"current": gap_current, "prior": gap_prior},
        "stale_due_count": stale["count"],
    }

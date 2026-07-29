"""Per-org ROI counters backing the weekly ROI number shown to customers:
rules served, actions checked, blocked/needs_human counts have to be real
numbers a customer can see, not stdout log lines with no query interface.

_log_mcp_call (mcp_server/server.py) already prints every one of these
signals to stdout, but that stream is documented as future pricing/usage
data with no GROUP BY/COUNT/SUM interface — the same limitation
gap_tracking.py's module docstring explains for why gap tracking needed a
real table instead of relying on that stream. roi_counters (migration
0023) is the equivalent here: a minimal per-org, per-day counters table
that search_rules/get_rule/check_action increment directly, best-effort,
same non-blocking discipline as gap_tracking.log_gap.

Deliberately NOT wired into `actions_checked` for search_rules/get_rule
(only check_action calls those) and NOT tracking `allowed` verdicts
separately from a bare actions_checked total — what customers care about
is "blocked/needs_human counts", and an allowed-vs-total distinction is
recoverable later (actions_checked - blocked - needs_human) without a
fourth column if it turns out to matter.
"""

from datetime import date, datetime, timedelta, timezone
from typing import Any

import sentry_sdk
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.db.models import RoiCounter
from gnt.db.rls import scope_to_org

# The only columns a caller is allowed to bump — mirrors gap_tracking.py's
# _KNOWN_TOOLS guard, so a typo'd metric name fails loudly (to Sentry, not
# to the caller) instead of silently no-op-ing or raising out of a hot
# MCP-serving call.
_KNOWN_METRICS = {"rules_served", "actions_checked", "actions_blocked", "actions_needs_human"}

# A week-over-week comparison ("is this number improving") needs two
# non-overlapping 7-day windows, both anchored on the same "today".
_WINDOW_DAYS = 7


async def bump_roi_counters(
    session: AsyncSession, org_id: str, counters: dict[str, int], *, today: date | None = None
) -> None:
    """Best-effort increment of one or more of this org's counters for
    `today` (default: the real current date). Any failure here (including
    the assertion below on a caller bug) is reported to Sentry and
    swallowed, never re-raised — mirrors gap_tracking.log_gap's own
    must-never-break-the-MCP-call discipline exactly, since this rides
    along the same hot path.

    Takes every metric to bump in one call (not one call per metric) so
    check_action's "actions_checked +1 AND (actions_blocked +1 OR
    actions_needs_human +1)" only costs one upsert, not two.

    Re-scopes app.current_org itself and owns its own commit, same
    "scope again, own the commit" pattern log_gap follows, since callers
    invoke this after their own request/tool logic already ran."""
    if not counters:
        return
    try:
        for metric in counters:
            assert metric in _KNOWN_METRICS, f"unknown roi counter: {metric!r}"
        await scope_to_org(session, org_id)
        # UTC, not the server's local date — see roi_summary.build_roi_summary's
        # matching comment. The MCP-serving path (mcp_server/server.py) that
        # calls this runs on whatever timezone the deployed container happens
        # to have, and every other timestamp this counter is compared against
        # (RuleGap.created_at, RuleStaleness.computed_at, ...) is UTC.
        day = today or datetime.now(timezone.utc).date()
        stmt = insert(RoiCounter).values(org_id=org_id, day=day, **counters)
        stmt = stmt.on_conflict_do_update(
            index_elements=["org_id", "day"],
            set_={
                metric: getattr(RoiCounter, metric) + stmt.excluded[metric] for metric in counters
            }
            | {"updated_at": func.now()},
        )
        await session.execute(stmt)
        await session.commit()
    except Exception as exc:
        sentry_sdk.capture_exception(exc)
        await session.rollback()


async def summary_for_window(
    session: AsyncSession, org_id: str, *, end: date | None = None, window_days: int = _WINDOW_DAYS
) -> dict[str, Any]:
    """This org's counters summed over two trailing windows of
    `window_days` each, ending `end` (default: today) — "current" is
    [end - window_days + 1, end], "prior" is the `window_days` immediately
    before that. Backs both the weekly digest and GET /v1/roi/summary
    (`gnt status`'s ROI numbers): both want "this week's number" and
    "is that number moving", not just a single all-time total."""
    await scope_to_org(session, org_id)
    # UTC — see bump_roi_counters's matching comment; the write and read
    # sides of roi_counters.day must agree on what "today" means.
    end = end or datetime.now(timezone.utc).date()
    current_start = end - timedelta(days=window_days - 1)
    prior_end = current_start - timedelta(days=1)
    prior_start = prior_end - timedelta(days=window_days - 1)

    current = await _sum_window(session, org_id, current_start, end)
    prior = await _sum_window(session, org_id, prior_start, prior_end)
    return {"window_days": window_days, "current": current, "prior": prior}


async def _sum_window(session: AsyncSession, org_id: str, start: date, end: date) -> dict[str, int]:
    stmt = select(
        func.coalesce(func.sum(RoiCounter.rules_served), 0),
        func.coalesce(func.sum(RoiCounter.actions_checked), 0),
        func.coalesce(func.sum(RoiCounter.actions_blocked), 0),
        func.coalesce(func.sum(RoiCounter.actions_needs_human), 0),
    ).where(RoiCounter.org_id == org_id, RoiCounter.day >= start, RoiCounter.day <= end)
    row = (await session.execute(stmt)).one()
    return {
        "rules_served": int(row[0]),
        "actions_checked": int(row[1]),
        "actions_blocked": int(row[2]),
        "actions_needs_human": int(row[3]),
    }

"""Coverage-gap tracking for gap-aware answers. A
"gap" is a serving-path signal that no approved rule covers a query:

- search_rules: zero hits after the same similarity threshold search_rules
  already applies to every result (see mcp_server/server.py's own
  search_rules_similarity_threshold usage) — that threshold IS the
  relevance floor, so there's no separate "below relevance floor" judgment
  to make here on top of it.
- check_action: a needs_human verdict whose reason was specifically "no
  rule covers this" — action_check.py's `no_coverage` flag, not the
  "rules retrieved but ambiguous" needs_human branch, which isn't a gap.

Persisted in Postgres (RuleGap / rule_gaps, migration 0019), not only the
stdout _log_mcp_call stream every MCP call already gets: that stream is
documented as future pricing/usage data, and printing has no query
interface — `gnt gaps` needs to GROUP BY / COUNT / ORDER BY to answer
"top uncovered queries", which stdout logs can't serve without a
log-shipping pipeline this codebase doesn't have.

Same best-effort discipline as onboarding_metrics.log_onboarding_event:
gap logging must never break the MCP call it rides along with.
"""

from datetime import date, datetime, time, timezone

import sentry_sdk
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.db.models import RuleGap
from gnt.db.rls import scope_to_org
from gnt.pipeline.sanitize import sanitize

_KNOWN_TOOLS = {"search_rules", "check_action"}
# Generous but bounded — a gap row exists to be read back as a short
# "uncovered query" list (gnt gaps), not to store an unbounded
# check_action description/context blob verbatim.
_MAX_QUERY_TEXT = 500


async def log_gap(session: AsyncSession, org_id: str, tool: str, query_text: str) -> None:
    """Best-effort — any failure here (including the assertion below on a
    caller bug) is reported to Sentry and swallowed, never re-raised.
    Re-scopes app.current_org itself, same "scope again, own the commit"
    pattern log_onboarding_event follows, since callers invoke this after
    their own request/tool logic already ran."""
    try:
        assert tool in _KNOWN_TOOLS, f"unknown gap tool: {tool!r}"
        await scope_to_org(session, org_id)
        session.add(
            RuleGap(org_id=org_id, tool=tool, query_text=sanitize(query_text)[:_MAX_QUERY_TEXT])
        )
        await session.commit()
    except Exception as exc:
        sentry_sdk.capture_exception(exc)
        await session.rollback()


async def list_top_gaps(session: AsyncSession, org_id: str, limit: int = 20) -> list[dict]:
    """Aggregates this org's gap rows into its top uncovered queries,
    grouped by (tool, normalized query text) — lowercased/trimmed exact
    match only, not fuzzy clustering ("refund policy?" and "refund policy"
    count as two distinct gaps, not one). A real semantic dedup pass is
    future work, not built here.

    Ranked by how often a query recurred, tie-broken by most recent — a
    query asked a dozen times last week is a bigger coverage hole than one
    asked once yesterday, which is the signal `gnt gaps` exists to
    surface."""
    await scope_to_org(session, org_id)
    normalized = func.lower(func.trim(RuleGap.query_text))
    stmt = (
        select(
            RuleGap.tool,
            normalized.label("query_text"),
            func.count().label("hit_count"),
            func.max(RuleGap.created_at).label("last_seen"),
        )
        .where(RuleGap.org_id == org_id)
        .group_by(RuleGap.tool, normalized)
        .order_by(func.count().desc(), func.max(RuleGap.created_at).desc())
        .limit(limit)
    )
    rows = (await session.execute(stmt)).all()
    return [
        {"tool": tool, "query": query_text, "count": hit_count, "last_seen": last_seen.isoformat()}
        for tool, query_text, hit_count, last_seen in rows
    ]


async def count_gaps_between(session: AsyncSession, org_id: str, start: date, end: date) -> int:
    """How many gap rows (raw hits, not deduped like list_top_gaps above)
    this org logged between `start` and `end`, both inclusive whole days.
    Backs the "coverage growth" number shown in the weekly digest: it
    (workers/tasks_digest.py) calls this for the current and prior 7-day
    windows the same way roi_metrics.summary_for_window does for
    roi_counters, so "gaps are shrinking" is a real week-over-week
    comparison, not a single point-in-time count with nothing to compare
    against."""
    await scope_to_org(session, org_id)
    start_at = datetime.combine(start, time.min, tzinfo=timezone.utc)
    end_at = datetime.combine(end, time.max, tzinfo=timezone.utc)
    stmt = (
        select(func.count())
        .select_from(RuleGap)
        .where(RuleGap.org_id == org_id, RuleGap.created_at >= start_at, RuleGap.created_at <= end_at)
    )
    return (await session.execute(stmt)).scalar_one()

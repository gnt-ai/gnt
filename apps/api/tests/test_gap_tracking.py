"""rule_gaps / gap_tracking.py (gap-aware answers: when nothing governs a
question, that gets recorded as a real gap instead of silently succeeding).
Covers: log_gap writes a real row and is genuinely best-effort (a failure
never raises out to the caller), RLS actually isolates one org's gaps from
another's at the database level (mirrors test_onboarding_metrics.py's
org-scoping pattern), list_top_gaps aggregates by (tool, normalized query
text) ranked by count then recency, and GET /v1/gaps is scoped to the
caller's own org.
"""

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select

from gnt.db.models import RuleGap
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.gap_tracking import count_gaps_between, list_top_gaps, log_gap
from gnt.routers import gaps as gaps_router
from tests.conftest import make_org_client


async def test_log_gap_writes_row(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    await log_gap(db_session, org_a, "search_rules", "what's our refund policy")

    await scope_to_org(db_session, org_a)
    rows = (await db_session.execute(select(RuleGap).where(RuleGap.org_id == org_a))).scalars().all()
    assert len(rows) == 1
    assert rows[0].tool == "search_rules"
    assert rows[0].query_text == "what's our refund policy"


async def test_log_gap_swallows_failures(db_session, org_a, monkeypatch):
    """An unknown tool name trips the helper's internal assertion — proof
    that even a bug inside the helper can't escape and break whatever MCP
    call it's riding along in."""
    captured: list[Exception] = []
    monkeypatch.setattr("gnt.gap_tracking.sentry_sdk.capture_exception", lambda exc: captured.append(exc))

    await ensure_org(db_session, org_a)
    await db_session.commit()

    await log_gap(db_session, org_a, "not_a_real_tool", "some query")

    assert len(captured) == 1
    await scope_to_org(db_session, org_a)
    rows = (await db_session.execute(select(RuleGap).where(RuleGap.org_id == org_a))).scalars().all()
    assert rows == []


async def test_rule_gaps_are_org_isolated_by_rls(db_session, org_a, org_b):
    await ensure_org(db_session, org_a)
    await ensure_org(db_session, org_b)
    await db_session.commit()

    await log_gap(db_session, org_a, "search_rules", "org a's uncovered query")

    # Scoped as org_b, org_a's row must be invisible even though the query
    # itself doesn't filter by org_id -- the RLS policy does the filtering.
    await scope_to_org(db_session, org_b)
    org_b_view = (await db_session.execute(select(RuleGap))).scalars().all()
    assert org_b_view == []

    await scope_to_org(db_session, org_a)
    org_a_view = (await db_session.execute(select(RuleGap))).scalars().all()
    assert len(org_a_view) == 1
    assert org_a_view[0].org_id == org_a


async def test_list_top_gaps_ranks_by_count_then_recency(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    # "refund policy" asked 3x (case/whitespace-insensitive dedup),
    # "return window" asked once -- the repeated query should rank first.
    await log_gap(db_session, org_a, "search_rules", "refund policy")
    await log_gap(db_session, org_a, "search_rules", "Refund Policy")
    await log_gap(db_session, org_a, "search_rules", "  refund policy  ")
    await log_gap(db_session, org_a, "check_action", "return window")

    top = await list_top_gaps(db_session, org_a, limit=10)
    assert len(top) == 2
    assert top[0]["tool"] == "search_rules"
    assert top[0]["query"] == "refund policy"
    assert top[0]["count"] == 3
    assert top[1]["tool"] == "check_action"
    assert top[1]["query"] == "return window"
    assert top[1]["count"] == 1


async def test_list_top_gaps_respects_limit(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    for query in ("a", "b", "c"):
        await log_gap(db_session, org_a, "search_rules", query)

    top = await list_top_gaps(db_session, org_a, limit=2)
    assert len(top) == 2


async def test_get_gaps_endpoint_is_scoped_to_current_org(db_session, test_app_factory, org_a, org_b):
    await ensure_org(db_session, org_a)
    await ensure_org(db_session, org_b)
    await db_session.commit()

    await log_gap(db_session, org_a, "search_rules", "org a's uncovered query")

    client_b = make_org_client(test_app_factory, org_b, routers=[gaps_router.router])
    async with client_b:
        r = await client_b.get("/v1/gaps")
    assert r.status_code == 200
    assert r.json() == []

    client_a = make_org_client(test_app_factory, org_a, routers=[gaps_router.router])
    async with client_a:
        r = await client_a.get("/v1/gaps")
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    assert body[0]["query"] == "org a's uncovered query"


# --- count_gaps_between (the digest's "coverage growth" number) ---


async def _seed_gap_at(session, org_id: str, created_at) -> None:
    """log_gap always timestamps at insert time (server_default=now()) —
    count_gaps_between's window math needs gaps at specific, arbitrary
    dates, so this inserts a row directly with an explicit created_at
    rather than going through log_gap."""
    from gnt.pipeline.sanitize import sanitize

    session.add(RuleGap(org_id=org_id, tool="search_rules", query_text=sanitize("q"), created_at=created_at))


async def test_count_gaps_between_counts_only_rows_inside_the_window(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()
    await scope_to_org(db_session, org_a)

    today = date(2026, 7, 20)
    inside = [
        datetime.combine(today, datetime.min.time(), tzinfo=timezone.utc),
        datetime.combine(today - timedelta(days=6), datetime.min.time(), tzinfo=timezone.utc),
    ]
    outside = [
        datetime.combine(today - timedelta(days=7), datetime.min.time(), tzinfo=timezone.utc),
        datetime.combine(today + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc),
    ]
    for created_at in inside + outside:
        await _seed_gap_at(db_session, org_a, created_at)
    await db_session.commit()

    count = await count_gaps_between(db_session, org_a, today - timedelta(days=6), today)
    assert count == 2


async def test_count_gaps_between_is_org_isolated(db_session, org_a, org_b):
    await ensure_org(db_session, org_a)
    await ensure_org(db_session, org_b)
    await db_session.commit()
    await scope_to_org(db_session, org_a)

    today = date(2026, 7, 20)
    await _seed_gap_at(db_session, org_a, datetime.combine(today, datetime.min.time(), tzinfo=timezone.utc))
    await db_session.commit()

    await scope_to_org(db_session, org_b)
    count_b = await count_gaps_between(db_session, org_b, today - timedelta(days=6), today)
    assert count_b == 0

    await scope_to_org(db_session, org_a)
    count_a = await count_gaps_between(db_session, org_a, today - timedelta(days=6), today)
    assert count_a == 1

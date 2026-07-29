"""gnt.staleness (staleness surfaced at serving time). Covers: the decay
math itself (age_days/freshness_score/is_stale),
rule_freshness's None-for-never-approved and lastValidatedAt-over-
approvedAt basis rules, and list_due_for_revalidation's RLS-scoped read
of the rule_staleness table `gnt stale` / GET /v1/rules/staleness/due
back onto.
"""

import math
from datetime import datetime, timedelta, timezone

from gnt.db.models import RuleStaleness
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.staleness import (
    DECAY_LAMBDA,
    STALE_THRESHOLD_DAYS,
    age_days,
    freshness_score,
    is_stale,
    list_due_for_revalidation,
    rule_freshness,
)


def test_age_days_computes_elapsed_time():
    now = datetime(2026, 7, 17, tzinfo=timezone.utc)
    reference = (now - timedelta(days=10)).isoformat()
    assert age_days(reference, now=now) == 10.0


def test_age_days_clamps_future_reference_to_zero():
    now = datetime(2026, 7, 17, tzinfo=timezone.utc)
    reference = (now + timedelta(days=5)).isoformat()
    assert age_days(reference, now=now) == 0.0


def test_age_days_treats_naive_reference_as_utc():
    now = datetime(2026, 7, 17, tzinfo=timezone.utc)
    naive_reference = (now - timedelta(days=3)).replace(tzinfo=None).isoformat()
    assert age_days(naive_reference, now=now) == 3.0


def test_freshness_score_is_one_at_zero_age():
    assert freshness_score(0.0) == 1.0


def test_freshness_score_matches_exponential_decay_formula():
    assert math.isclose(freshness_score(30.0), math.exp(-DECAY_LAMBDA * 30.0))


def test_freshness_score_decreases_with_age():
    assert freshness_score(60.0) < freshness_score(30.0) < freshness_score(0.0)


def test_is_stale_threshold_is_six_weeks():
    assert STALE_THRESHOLD_DAYS == 42.0
    assert is_stale(41.9) is False
    assert is_stale(42.0) is True


def _rule(**overrides) -> dict:
    base = {
        "slug": "rules/abc",
        "title": "Refund window",
        "status": "approved",
        "approvedAt": "2026-06-01T00:00:00+00:00",
        "lastValidatedAt": None,
    }
    base.update(overrides)
    return base


def test_rule_freshness_none_for_never_approved_rule():
    draft = _rule(status="draft", approvedAt=None, lastValidatedAt=None)
    assert rule_freshness(draft) is None


def test_rule_freshness_uses_approved_at_when_never_revalidated():
    now = datetime(2026, 7, 17, tzinfo=timezone.utc)
    rule = _rule(approvedAt="2026-06-01T00:00:00+00:00", lastValidatedAt=None)

    freshness = rule_freshness(rule, now=now)

    assert freshness["basis"] == "approved_at"
    assert freshness["estimate"] is True
    assert freshness["age_days"] == 46.0
    assert freshness["stale"] is True


def test_rule_freshness_prefers_last_validated_at_over_approved_at():
    now = datetime(2026, 7, 17, tzinfo=timezone.utc)
    rule = _rule(
        approvedAt="2026-01-01T00:00:00+00:00",
        lastValidatedAt="2026-07-16T00:00:00+00:00",
    )

    freshness = rule_freshness(rule, now=now)

    assert freshness["basis"] == "last_validated_at"
    assert freshness["age_days"] == 1.0
    assert freshness["stale"] is False


async def test_list_due_for_revalidation_only_returns_stale_rows(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()
    await scope_to_org(db_session, org_a)

    now = datetime.now(timezone.utc)
    db_session.add_all(
        [
            RuleStaleness(
                org_id=org_a,
                rule_slug="rules/stale-one",
                title="Stale rule",
                age_days=50.0,
                freshness_score=freshness_score(50.0),
                is_stale=True,
                computed_at=now,
            ),
            RuleStaleness(
                org_id=org_a,
                rule_slug="rules/fresh-one",
                title="Fresh rule",
                age_days=2.0,
                freshness_score=freshness_score(2.0),
                is_stale=False,
                computed_at=now,
            ),
        ]
    )
    await db_session.commit()

    result = await list_due_for_revalidation(db_session, org_a)

    assert result["count"] == 1
    assert len(result["rules"]) == 1
    assert result["rules"][0]["rule_id"] == "stale-one"
    assert result["rules"][0]["title"] == "Stale rule"
    assert result["rules"][0]["estimate"] is True


async def test_list_due_for_revalidation_orders_oldest_first(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()
    await scope_to_org(db_session, org_a)

    now = datetime.now(timezone.utc)
    db_session.add_all(
        [
            RuleStaleness(
                org_id=org_a,
                rule_slug="rules/mildly-stale",
                title="Mildly stale",
                age_days=45.0,
                freshness_score=freshness_score(45.0),
                is_stale=True,
                computed_at=now,
            ),
            RuleStaleness(
                org_id=org_a,
                rule_slug="rules/very-stale",
                title="Very stale",
                age_days=200.0,
                freshness_score=freshness_score(200.0),
                is_stale=True,
                computed_at=now,
            ),
        ]
    )
    await db_session.commit()

    result = await list_due_for_revalidation(db_session, org_a)

    assert [r["rule_id"] for r in result["rules"]] == ["very-stale", "mildly-stale"]


async def test_list_due_for_revalidation_is_org_isolated_by_rls(db_session, org_a, org_b):
    await ensure_org(db_session, org_a)
    await ensure_org(db_session, org_b)
    await db_session.commit()
    await scope_to_org(db_session, org_a)

    db_session.add(
        RuleStaleness(
            org_id=org_a,
            rule_slug="rules/org-a-stale",
            title="Org A stale rule",
            age_days=60.0,
            freshness_score=freshness_score(60.0),
            is_stale=True,
            computed_at=datetime.now(timezone.utc),
        )
    )
    await db_session.commit()

    org_b_result = await list_due_for_revalidation(db_session, org_b)
    assert org_b_result == {"count": 0, "rules": []}

    org_a_result = await list_due_for_revalidation(db_session, org_a)
    assert org_a_result["count"] == 1

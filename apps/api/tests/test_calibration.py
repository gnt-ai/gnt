"""calibration_events / calibration.py — labels confidence/decay as
uncalibrated, and starts collecting calibration data.
Covers each of the three calibration inputs' write paths directly (this
module has no HTTP surface of its own — routers/rules.py and
routers/github_webhook.py's own tests cover the call sites), that every
write is genuinely best-effort, and RLS isolation, mirroring
test_gap_tracking.py's/test_onboarding_metrics.py's own coverage shape.
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from gnt.calibration import (
    log_conflict_flagged,
    log_conflict_override_if_flagged,
    log_deprecation,
    log_revalidation_if_previously_stale,
)
from gnt.db.models import CalibrationEvent, RuleStaleness
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org


async def _rows(db_session, org_id: str) -> list[CalibrationEvent]:
    await scope_to_org(db_session, org_id)
    return (
        (await db_session.execute(select(CalibrationEvent).where(CalibrationEvent.org_id == org_id)))
        .scalars()
        .all()
    )


async def test_log_deprecation_records_age_off_approved_at(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    rule = {
        "slug": "rules/deprecated-rule",
        "lastValidatedAt": None,
        "approvedAt": "2026-06-01T00:00:00Z",
    }
    await log_deprecation(db_session, org_a, rule)

    rows = await _rows(db_session, org_a)
    assert len(rows) == 1
    assert rows[0].event_type == "rule_deprecated"
    assert rows[0].rule_slug == "rules/deprecated-rule"
    assert rows[0].age_days > 0


async def test_log_deprecation_prefers_last_validated_at_over_approved_at(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rule = {
        "slug": "rules/revalidated-rule",
        "lastValidatedAt": yesterday,
        "approvedAt": "2026-01-01T00:00:00Z",
    }
    await log_deprecation(db_session, org_a, rule)

    rows = await _rows(db_session, org_a)
    assert len(rows) == 1
    # A day or so old (re-validated yesterday), not six-plus months old
    # (which is what using approvedAt instead would report).
    assert rows[0].age_days < 5


async def test_log_deprecation_is_a_no_op_for_a_rule_never_approved(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    rule = {"slug": "rules/never-approved", "lastValidatedAt": None, "approvedAt": None}
    await log_deprecation(db_session, org_a, rule)

    assert await _rows(db_session, org_a) == []


async def test_log_deprecation_swallows_failures(db_session, org_a, monkeypatch):
    captured: list[Exception] = []
    monkeypatch.setattr("gnt.calibration.sentry_sdk.capture_exception", lambda exc: captured.append(exc))

    await ensure_org(db_session, org_a)
    await db_session.commit()

    # A missing "slug" key trips the helper (rule["slug"] raises KeyError)
    # rather than a legitimate no-reference no-op — proof a bug here can't
    # escape and break the deprecate_rule request it rides along with.
    await log_deprecation(db_session, org_a, {"approvedAt": "2026-06-01T00:00:00Z"})

    assert len(captured) == 1
    assert await _rows(db_session, org_a) == []


async def test_conflict_flagged_then_override_detected_at_merge(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    conflict = {"relation": "contradicts", "slug": "rules/existing"}
    await log_conflict_flagged(db_session, org_a, "rules/new-rule", 42, conflict)
    await log_conflict_override_if_flagged(db_session, org_a, "rules/new-rule", 42)

    rows = await _rows(db_session, org_a)
    event_types = sorted(row.event_type for row in rows)
    assert event_types == ["conflict_flagged", "conflict_override"]
    override = next(row for row in rows if row.event_type == "conflict_override")
    assert override.pr_number == 42
    assert override.detail == {"relation": "contradicts", "candidate_slug": "rules/existing"}


async def test_conflict_override_is_a_no_op_when_nothing_was_flagged(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    # Every ordinary merge takes this path -- must stay silent, not log a
    # "no override" row for it.
    await log_conflict_override_if_flagged(db_session, org_a, "rules/never-flagged", 7)

    assert await _rows(db_session, org_a) == []


async def test_conflict_override_only_matches_the_same_pr_number(db_session, org_a):
    """A rule can be proposed more than once (reject, then re-propose) --
    a conflict flagged on an earlier, abandoned PR must not be mistaken
    for an override on a later, different PR for the same rule slug."""
    await ensure_org(db_session, org_a)
    await db_session.commit()

    conflict = {"relation": "duplicate", "slug": "rules/other"}
    await log_conflict_flagged(db_session, org_a, "rules/re-proposed", 10, conflict)
    await log_conflict_override_if_flagged(db_session, org_a, "rules/re-proposed", 11)

    rows = await _rows(db_session, org_a)
    assert [row.event_type for row in rows] == ["conflict_flagged"]


async def test_revalidation_outcome_logged_when_previously_flagged_stale(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()
    await scope_to_org(db_session, org_a)
    db_session.add(
        RuleStaleness(
            org_id=org_a,
            rule_slug="rules/stale-rule",
            title="Stale rule",
            age_days=90.0,
            freshness_score=0.4,
            is_stale=True,
            computed_at=datetime.now(timezone.utc),
        )
    )
    await db_session.commit()

    await log_revalidation_if_previously_stale(db_session, org_a, "rules/stale-rule", "deprecated")

    rows = await _rows(db_session, org_a)
    assert len(rows) == 1
    assert rows[0].event_type == "revalidation_outcome"
    assert rows[0].age_days == 90.0
    assert rows[0].detail == {"action": "deprecated"}


async def test_revalidation_outcome_is_a_no_op_when_never_flagged_stale(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()

    # Most edits/deprecations aren't a response to a staleness flag --
    # must stay silent for them, not log one for every ordinary edit.
    await log_revalidation_if_previously_stale(db_session, org_a, "rules/never-flagged", "edited")

    assert await _rows(db_session, org_a) == []


async def test_calibration_events_are_org_isolated_by_rls(db_session, org_a, org_b):
    await ensure_org(db_session, org_a)
    await ensure_org(db_session, org_b)
    await db_session.commit()

    await log_deprecation(
        db_session, org_a, {"slug": "rules/org-a-rule", "lastValidatedAt": None, "approvedAt": "2026-06-01T00:00:00Z"}
    )

    await scope_to_org(db_session, org_b)
    org_b_view = (await db_session.execute(select(CalibrationEvent))).scalars().all()
    assert org_b_view == []

    await scope_to_org(db_session, org_a)
    org_a_view = (await db_session.execute(select(CalibrationEvent))).scalars().all()
    assert len(org_a_view) == 1
    assert org_a_view[0].org_id == org_a

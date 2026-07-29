"""Calibration-data instrumentation: label confidence/decay as uncalibrated,
and start collecting calibration data.
Confidence scores are model-assigned at creation time and decay lambdas
are admitted first-pass guesses — see mcp_server/server.py's and
routers/rules.py's `confidence_estimate` field, and gnt.staleness's
module docstring, for where and why those numbers get labeled. This
module captures the real-world signals a future calibration pass would
need to check whether those guesses are any good.

Same append-only, best-effort, org-scoped discipline as gap_tracking.py
and onboarding_metrics.py: every public function here owns its own
scope/commit and swallows its own failures, because none of these calls
are allowed to break the request or webhook delivery they ride along
with. Unlike those two modules, this one is pure instrumentation with no
reader anywhere in this codebase yet (no `gnt calibration` command) — the
data exists for a future calibration pass, not a feature shipping today.

Three signals, one table (CalibrationEvent / calibration_events), since
all three are small, low-volume, structurally similar "something happened
to a rule, worth remembering for later" events — see that model's
docstring for the full shape and reasoning.
"""

import sentry_sdk
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.db.models import CalibrationEvent, RuleStaleness
from gnt.db.rls import scope_to_org
from gnt.staleness import age_days

_KNOWN_EVENT_TYPES = {
    "rule_deprecated",
    "conflict_flagged",
    "conflict_override",
    "revalidation_outcome",
}


async def _insert(
    session: AsyncSession,
    org_id: str,
    event_type: str,
    *,
    rule_slug: str | None = None,
    pr_number: int | None = None,
    age: float | None = None,
    detail: dict | None = None,
) -> None:
    assert event_type in _KNOWN_EVENT_TYPES, f"unknown calibration event_type: {event_type!r}"
    await scope_to_org(session, org_id)
    session.add(
        CalibrationEvent(
            org_id=org_id,
            event_type=event_type,
            rule_slug=rule_slug,
            pr_number=pr_number,
            age_days=age,
            detail=detail,
        )
    )
    await session.commit()


async def log_deprecation(session: AsyncSession, org_id: str, rule: dict) -> None:
    """Rule age at deprecation. Called from deprecate_rule with the rule
    as it stood right before the deprecate write. A rule deprecated
    before ever being approved (draft/in_review — an edge case the
    endpoint itself doesn't block) has no approvedAt/lastValidatedAt to
    measure age from, so this is a no-op for it — same "no reference, no
    estimate" call gnt.staleness.rule_freshness makes."""
    try:
        reference = rule.get("lastValidatedAt") or rule.get("approvedAt")
        if reference is None:
            return
        await _insert(session, org_id, "rule_deprecated", rule_slug=rule["slug"], age=age_days(reference))
    except Exception as exc:
        sentry_sdk.capture_exception(exc)
        await session.rollback()


async def log_conflict_flagged(
    session: AsyncSession, org_id: str, rule_slug: str, pr_number: int, conflict: dict
) -> None:
    """Called from propose_rule right after a PR opens with a
    pipeline/rule_conflict.py warning in its body. Records what was
    flagged so log_conflict_override_if_flagged below can tell, at merge
    time, whether the human merged past it."""
    try:
        await _insert(
            session,
            org_id,
            "conflict_flagged",
            rule_slug=rule_slug,
            pr_number=pr_number,
            detail={"relation": conflict["relation"], "candidate_slug": conflict["slug"]},
        )
    except Exception as exc:
        sentry_sdk.capture_exception(exc)
        await session.rollback()


async def log_conflict_override_if_flagged(
    session: AsyncSession, org_id: str, rule_slug: str, pr_number: int
) -> None:
    """Reviewer override of a conflict flag. Called from the GitHub
    webhook handler once a merge is confirmed real. A no-op unless
    propose_rule flagged a conflict on this exact PR — most merges never
    did, and this must stay silent for those rather than log a
    "no override" row for every ordinary merge."""
    try:
        await scope_to_org(session, org_id)
        flagged = (
            await session.execute(
                select(CalibrationEvent).where(
                    CalibrationEvent.org_id == org_id,
                    CalibrationEvent.event_type == "conflict_flagged",
                    CalibrationEvent.rule_slug == rule_slug,
                    CalibrationEvent.pr_number == pr_number,
                )
            )
        ).scalars().first()
        if flagged is None:
            return
        await _insert(
            session,
            org_id,
            "conflict_override",
            rule_slug=rule_slug,
            pr_number=pr_number,
            detail=flagged.detail,
        )
    except Exception as exc:
        sentry_sdk.capture_exception(exc)
        await session.rollback()


async def log_revalidation_if_previously_stale(
    session: AsyncSession, org_id: str, rule_slug: str, action: str
) -> None:
    """Re-validation outcome from the nightly rule-staleness sweep
    (gnt.staleness, run via workers/tasks_staleness.py's
    compute_rule_staleness). Called from deprecate_rule and edit_rule. A
    no-op unless that sweep's last nightly run had this exact rule
    flagged stale — most
    deprecations/edits aren't a response to a staleness flag, and logging
    one for every ordinary edit would drown the signal this exists to
    capture."""
    try:
        await scope_to_org(session, org_id)
        snapshot = (
            await session.execute(
                select(RuleStaleness).where(
                    RuleStaleness.org_id == org_id,
                    RuleStaleness.rule_slug == rule_slug,
                    RuleStaleness.is_stale.is_(True),
                )
            )
        ).scalars().first()
        if snapshot is None:
            return
        await _insert(
            session,
            org_id,
            "revalidation_outcome",
            rule_slug=rule_slug,
            age=snapshot.age_days,
            detail={"action": action},
        )
    except Exception as exc:
        sentry_sdk.capture_exception(exc)
        await session.rollback()

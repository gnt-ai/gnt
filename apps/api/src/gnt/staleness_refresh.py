"""Dedup log for the staleness sweep's refresh-or-deprecate proposals (see
workers/tasks_staleness.py for the nightly job that writes this table).
One row per (org_id, rule_slug, reason, content_fingerprint) the sweep has
already opened a refresh-or-deprecate PR for — checked before a new draft
version/PR gets created for the same rule again, so an unresolved flag
doesn't get re-proposed (and re-PR'd) every single night until a human
actually merges or rejects it.

content_fingerprint is part of the key, not just (org_id, rule_slug,
reason), so a source that drifts again before anyone reviews the first
proposal produces a genuinely new row rather than being silently
suppressed forever by it — see workers/tasks_staleness.py's _fingerprint.

Same append-only, best-effort, org-scoped discipline as
contradiction_findings.py on the write side: record_proposal owns its own
scope/commit and swallows its own failures, since it must never break the
sweep it rides along with. has_been_proposed is a plain read used to gate
a PR-opening flow before it happens, not a write, so it re-scopes but
doesn't swallow — a failure there should surface (and abort that one
rule, via the caller's own try/except — see workers/tasks_staleness.py)
rather than silently return False and risk re-proposing a flag that's
already sitting in a customer's PR queue."""

import sentry_sdk
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.db.models import StalenessRefreshProposal
from gnt.db.rls import scope_to_org


async def has_been_proposed(
    session: AsyncSession, org_id: str, rule_slug: str, reason: str, content_fingerprint: str
) -> bool:
    """True if this exact (rule, reason, content_fingerprint) already has
    a proposal on record — the gate the nightly sweep checks before
    opening a new draft version/PR for a stale rule at all."""
    await scope_to_org(session, org_id)
    existing = (
        await session.execute(
            select(StalenessRefreshProposal.id).where(
                StalenessRefreshProposal.org_id == org_id,
                StalenessRefreshProposal.rule_slug == rule_slug,
                StalenessRefreshProposal.reason == reason,
                StalenessRefreshProposal.content_fingerprint == content_fingerprint,
            )
        )
    ).scalar_one_or_none()
    return existing is not None


async def record_proposal(
    session: AsyncSession,
    org_id: str,
    rule_slug: str,
    *,
    reason: str,
    source_path: str,
    content_fingerprint: str,
    new_rule_slug: str,
    pr_number: int,
    pr_url: str,
) -> None:
    """Called only after a real PR has actually been opened for this
    proposal — a row with no real PR behind it would silently suppress
    re-proposing forever with nothing for a human to ever see."""
    try:
        await scope_to_org(session, org_id)
        session.add(
            StalenessRefreshProposal(
                org_id=org_id,
                rule_slug=rule_slug,
                reason=reason,
                source_path=source_path,
                content_fingerprint=content_fingerprint,
                new_rule_slug=new_rule_slug,
                pr_number=pr_number,
                pr_url=pr_url,
            )
        )
        await session.commit()
    except Exception as exc:
        sentry_sdk.capture_exception(exc)
        await session.rollback()

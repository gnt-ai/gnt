"""Dedup log for the continuous contradiction sweeps.
One row per (org_id, rule_slug_a, rule_slug_b) pair the nightly sweep
(workers/tasks_contradictions.py) has already filed a GitHub issue for —
checked before judge_conflict runs on the same pair again, and before a
second issue gets opened for the same contradiction, so an unresolved
finding doesn't get re-flagged (and re-billed in LLM comparisons) every
night until a human actually resolves it.

rule_slug_a/rule_slug_b are always stored in sorted order (canonical_pair
below) so a pair sampled as (a, b) one night and (b, a) another still
dedupes as the same row — same-tag/search sampling has no guaranteed
ordering across runs.

Same append-only, best-effort, org-scoped discipline as calibration.py
and gap_tracking.py on the write side: record_finding owns its own
scope/commit and swallows its own failures, since it must never break
the sweep it rides along with. has_been_filed is a plain read used to
gate an LLM call before it happens, not a write, so it re-scopes but
doesn't swallow — a failure there should surface (and abort that one
pair, via the caller's own try/except — see workers/tasks_contradictions.py)
rather than silently return False and risk re-filing a pair that's
already sitting in a customer's issue tracker.
"""

import sentry_sdk
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.db.models import ContradictionFinding
from gnt.db.rls import scope_to_org


def canonical_pair(slug_a: str, slug_b: str) -> tuple[str, str]:
    """Sorted order, independent of which order a given pair was sampled
    in — the only ordering has_been_filed/record_finding ever store or
    query against."""
    first, second = sorted((slug_a, slug_b))
    return first, second


async def has_been_filed(session: AsyncSession, org_id: str, slug_a: str, slug_b: str) -> bool:
    """True if this exact pair (in either order) already has a filed
    finding on record — the gate the nightly sweep checks before
    spending a judge_conflict call on a candidate pair at all."""
    a, b = canonical_pair(slug_a, slug_b)
    await scope_to_org(session, org_id)
    existing = (
        await session.execute(
            select(ContradictionFinding.id).where(
                ContradictionFinding.org_id == org_id,
                ContradictionFinding.rule_slug_a == a,
                ContradictionFinding.rule_slug_b == b,
            )
        )
    ).scalar_one_or_none()
    return existing is not None


async def record_finding(
    session: AsyncSession,
    org_id: str,
    slug_a: str,
    slug_b: str,
    *,
    relation: str,
    issue_number: int,
    issue_url: str,
    pr_number: int | None = None,
    pr_url: str | None = None,
) -> None:
    """Called only after a GitHub issue has actually been opened for this
    pair — a row with no real filed issue behind it would silently
    suppress re-filing forever with nothing for a human to ever see.

    pr_number/pr_url record the sweep's proposed-
    resolution PR alongside the issue, when opening one succeeded — both
    optional, since that PR is a best-effort addition on top of the issue,
    not a second thing that has to succeed before this pair counts as
    filed. See workers/tasks_contradictions.py's own reasoning on why a PR
    failure still reaches this call with the issue's fields set and the PR
    ones left None, rather than skipping the write and leaving the pair
    open to a duplicate issue on the next run."""
    try:
        a, b = canonical_pair(slug_a, slug_b)
        await scope_to_org(session, org_id)
        session.add(
            ContradictionFinding(
                org_id=org_id,
                rule_slug_a=a,
                rule_slug_b=b,
                relation=relation,
                issue_number=issue_number,
                issue_url=issue_url,
                pr_number=pr_number,
                pr_url=pr_url,
            )
        )
        await session.commit()
    except Exception as exc:
        sentry_sdk.capture_exception(exc)
        await session.rollback()

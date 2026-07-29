"""Rule staleness/decay estimate.

Resurrects the decay math from the retired confidence-decay pipeline —
apps/api/src/gnt/decay.py and workers/tasks_cron.py, deleted in commit
2951286 along with the rest of the knowledge_unit ingest pipeline —
rather than reinventing it, since that job's exp(-lambda * age) formula
was already working, just tied to a model (KnowledgeUnit) that no longer
exists.

The old decay.py kept a per-type lambda table (DEFAULT_LAMBDA_BY_TYPE)
because KnowledgeUnit carried a closed `type` enum (pricing_rule, policy,
contact_protocol, procedure, fact, definition). apps/store's RulePage —
the model that replaced it — has no equivalent axis: compiler/cluster.py
says outright that a rule's tags are "free-form, not a single [type]".
There's nothing left to bucket a per-type rate by, so this collapses to
one flat rate: the old table's own FALLBACK_LAMBDA, the rate it already
used for anything outside its six hardcoded types. Not a new number.

Everything this module produces is an estimate —
decay_lambda was "admitted first-pass guesses" even before this rewrite,
and one flat rate is no more calibrated than six were. Every caller that
surfaces these numbers (MCP tool responses, the REST rule serializer,
`gnt stale`) must label them as such, never as a verified fact.
"""

import math
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.db.models import RuleStaleness
from gnt.db.rls import scope_to_org

# ~70-day half-life — decay.py's FALLBACK_LAMBDA, not a newly invented
# number. See module docstring for why there's no per-type table anymore.
DECAY_LAMBDA = 0.01

# Six weeks: a page that hasn't been re-validated in that long is treated
# as stale. A rule whose age crosses this is flagged as due for
# re-validation.
STALE_THRESHOLD_DAYS = 42.0


def age_days(reference_iso: str, *, now: datetime | None = None) -> float:
    """Days between `reference_iso` (an ISO-8601 timestamp, the shape
    apps/store's RulePage fields already are) and now. Clamped at 0 — a
    reference in the future (clock skew, bad data) reports "brand new",
    never a nonsensical negative age."""
    reference = datetime.fromisoformat(reference_iso)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    now = now or datetime.now(timezone.utc)
    return max((now - reference).total_seconds() / 86400.0, 0.0)


def freshness_score(age: float) -> float:
    """exp(-lambda * age): 1.0 at age 0, decaying toward 0 as a rule
    ages. Same formula the retired decay_confidence job applied to
    KnowledgeUnit.confidence — see module docstring for the lambda."""
    return math.exp(-DECAY_LAMBDA * age)


def is_stale(age: float) -> bool:
    return age >= STALE_THRESHOLD_DAYS


def rule_freshness(rule: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any] | None:
    """Freshness block for one apps/store RulePage dict (raw camelCase,
    as returned by store_client), or None if the rule has never been
    approved — draft/in_review/pending_merge carry no approvedAt yet, so
    age isn't a meaningful concept for them.

    Ages off lastValidatedAt when the rule has been re-validated at least
    once, falling back to approvedAt otherwise — a re-validation is
    exactly the event that should restart the staleness clock."""
    reference = rule.get("lastValidatedAt") or rule.get("approvedAt")
    if not reference:
        return None
    age = age_days(reference, now=now)
    return {
        "age_days": round(age, 1),
        "freshness_score": round(freshness_score(age), 3),
        "stale": is_stale(age),
        "estimate": True,
        "basis": "last_validated_at" if rule.get("lastValidatedAt") else "approved_at",
    }


async def list_due_for_revalidation(
    session: AsyncSession, org_id: str, *, limit: int = 50
) -> dict[str, Any]:
    """Rules the last nightly compute_rule_staleness run flagged as
    crossing the staleness threshold for this org, oldest first. Backs
    `gnt stale` — the stopgap this ships instead of a weekly digest
    (which doesn't exist yet; see workers/tasks_staleness.py)."""
    await scope_to_org(session, org_id)
    stale_filter = (RuleStaleness.org_id == org_id, RuleStaleness.is_stale.is_(True))
    count = (
        await session.execute(select(func.count()).select_from(RuleStaleness).where(*stale_filter))
    ).scalar_one()
    rows = (
        await session.execute(
            select(RuleStaleness)
            .where(*stale_filter)
            .order_by(RuleStaleness.age_days.desc())
            .limit(limit)
        )
    ).scalars().all()
    return {
        "count": count,
        "rules": [
            {
                "rule_id": row.rule_slug.removeprefix("rules/"),
                "title": row.title,
                "age_days": row.age_days,
                "freshness_score": row.freshness_score,
                "estimate": True,
                "computed_at": row.computed_at.isoformat(),
            }
            for row in rows
        ],
    }

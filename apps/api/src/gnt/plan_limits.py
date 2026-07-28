"""Per-tier monthly check_action call cap. A different axis from
llm_quota.py's dollar-based quota (that one's a spend safety net shared
across all three LLM call sites); this one's the plan's own advertised
number of check_action calls per month, tier-dependent, and it's the gate
that also decides whether an org's tier allows multi-org membership (see
apps/web/lib/auth.ts's beforeCreateInvitation).

Reuses roi_counters.actions_checked (migration 0023) as the count source
instead of a second counter table — check_action is roi_counters'
only actions_checked writer (see roi_metrics.py's module docstring), so a
calendar-month sum for an org is already exactly its check_action call
count for that month.
"""

from datetime import date, datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.db.models import Org, RoiCounter
from gnt.db.rls import scope_to_org
from gnt.db.session import get_sessionmaker

# Base ($29/mo): 1500 check_action calls/month. Pro ($149/mo — also the
# only tier that allows multi-org membership): 8000/month. Anything other
# than "pro" (including a null/unset plan_tier, or a trial org that hasn't
# picked a tier yet) is treated as base.
MONTHLY_ACTION_CAP: dict[str, int] = {"base": 1500, "pro": 8000}
DEFAULT_TIER = "base"


class PlanActionCapExceededError(RuntimeError):
    """Raised by enforce_plan_action_cap when this org has used its whole
    monthly check_action allowance for its plan tier."""


def cap_for_tier(tier: str | None) -> int:
    return MONTHLY_ACTION_CAP.get(
        tier or DEFAULT_TIER, MONTHLY_ACTION_CAP[DEFAULT_TIER]
    )


async def get_plan_action_usage(
    org_id: str, *, today: date | None = None
) -> tuple[int, int]:
    """Returns (calls used this calendar month, this org's monthly cap)."""
    # UTC — see roi_summary.build_roi_summary's matching comment; this reads
    # roi_counters.day, which roi_metrics.bump_roi_counters now buckets by
    # UTC date, so the month boundary here has to agree with that.
    month_start = (today or datetime.now(timezone.utc).date()).replace(day=1)
    session_factory = get_sessionmaker()
    async with session_factory() as session:
        await scope_to_org(session, org_id)
        org_tier = (
            await session.execute(select(Org.plan_tier).where(Org.id == org_id))
        ).scalar_one_or_none()
        used = (
            await session.execute(
                select(func.coalesce(func.sum(RoiCounter.actions_checked), 0)).where(
                    RoiCounter.org_id == org_id, RoiCounter.day >= month_start
                )
            )
        ).scalar_one()
    return int(used), cap_for_tier(org_tier)


async def check_plan_action_cap(org_id: str, *, today: date | None = None) -> bool:
    """True if org_id may make another check_action call this month. Plain
    bool, no exception — mirrors llm_quota.check_llm_quota's shape for a
    quiet check-then-skip caller."""
    used, cap = await get_plan_action_usage(org_id, today=today)
    return used < cap


async def enforce_plan_action_cap(org_id: str, *, today: date | None = None) -> None:
    """Raises PlanActionCapExceededError if org_id has already used its
    whole monthly check_action allowance. Mirrors llm_quota.enforce_llm_quota's
    shape: a self-contained pre-flight gate action_check.py calls right
    alongside the dollar quota check, before the paid model call fires."""
    used, cap = await get_plan_action_usage(org_id, today=today)
    if used >= cap:
        raise PlanActionCapExceededError(
            f"monthly check_action limit reached for org {org_id} ({used} of {cap})"
        )


async def org_plan_tier(session: AsyncSession, org_id: str) -> str:
    """The org's plan tier, defaulting to base for a null/unset value —
    for callers that already hold a scoped session (routers/billing.py's
    status endpoint) rather than opening a new one."""
    tier = (
        await session.execute(select(Org.plan_tier).where(Org.id == org_id))
    ).scalar_one_or_none()
    return tier or DEFAULT_TIER

"""Internal platform-admin dashboard API (founder-only, not customer-
facing). Every route here is gated on require_platform_admin, not the
org-scoped get_current_org/require_admin every other router uses, and
every read goes through get_admin_session (gnt_admin, migration 0035) —
the one connection in this codebase that legitimately sees every org at
once. See that migration's own docstring for why this role is SELECT-only
except for the one column-scoped write below.
"""

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.auth.better_auth import require_platform_admin
from gnt.db.models import (
    GithubConnection,
    IntercomConnection,
    LinearConnection,
    LlmUsage,
    McpApiKey,
    NotionConnection,
    Org,
    Rule,
    RuleGap,
    SlackConnection,
    ZendeskConnection,
)
from gnt.db.session import get_admin_session
from gnt.plan_limits import cap_for_tier

router = APIRouter(prefix="/v1/platform-admin", tags=["platform-admin"])

_RULE_STATUSES = ("draft", "in_review", "pending_merge", "approved", "deprecated")


def _current_month(today: date | None = None) -> date:
    # Same UTC month-boundary convention as llm_quota.py's own
    # _current_month and plan_limits.py's month_start — this dashboard's
    # numbers need to agree with what the org itself sees in its own
    # billing/usage views, not drift by using a different clock.
    return (today or datetime.now(timezone.utc).date()).replace(day=1)


@router.get("/orgs")
async def list_orgs(
    _email: str = Depends(require_platform_admin),
    session: AsyncSession = Depends(get_admin_session),
):
    """Every org on the platform, with plan/billing state, this month's
    check_action usage vs. its plan cap, and this month's LLM spend."""
    month = _current_month()

    orgs = (await session.execute(select(Org))).scalars().all()

    # Raw SQL, not a model join: better-auth's "member"/"organization"
    # tables aren't SQLAlchemy models in this codebase (they're managed by
    # apps/web's Better Auth config, not gnt's own Alembic migrations) --
    # org.name in particular only exists over there, orgs.name doesn't
    # exist at all (Org's primary key is the same id, nothing else).
    name_rows = (await session.execute(text('select id, name from "organization"'))).all()
    name_by_org = {row.id: row.name for row in name_rows}

    member_rows = (
        await session.execute(
            text('select "organizationId" as org_id, count(*) as n from "member" group by "organizationId"')
        )
    ).all()
    member_counts = {row.org_id: row.n for row in member_rows}

    usage_rows = (
        await session.execute(
            text(
                "select org_id, coalesce(sum(actions_checked), 0) as used "
                "from roi_counters where day >= :month_start group by org_id"
            ),
            {"month_start": month},
        )
    ).all()
    usage_by_org = {row.org_id: row.used for row in usage_rows}

    spend_rows = (
        await session.execute(select(LlmUsage.org_id, LlmUsage.estimated_cost_micros).where(LlmUsage.month == month))
    ).all()
    spend_by_org = {row.org_id: row.estimated_cost_micros for row in spend_rows}

    return [
        {
            "id": org.id,
            "name": name_by_org.get(org.id),
            "plan_tier": org.plan_tier,
            "subscription_status": org.subscription_status,
            "trial_ends_at": org.trial_ends_at,
            "member_count": member_counts.get(org.id, 0),
            "monthly_actions_used": usage_by_org.get(org.id, 0),
            "monthly_actions_cap": cap_for_tier(org.plan_tier),
            "llm_spend_cents_this_month": round(spend_by_org.get(org.id, 0) / 10_000),
        }
        for org in orgs
    ]


@router.get("/orgs/{org_id}")
async def get_org_detail(
    org_id: str,
    _email: str = Depends(require_platform_admin),
    session: AsyncSession = Depends(get_admin_session),
):
    org = (await session.execute(select(Org).where(Org.id == org_id))).scalar_one_or_none()
    if org is None:
        raise HTTPException(status_code=404, detail="org not found")

    org_name = (
        await session.execute(text('select name from "organization" where id = :org_id'), {"org_id": org_id})
    ).scalar_one_or_none()

    member_rows = (
        await session.execute(
            text(
                'select u.email, u.name, m.role from "member" m '
                'join "user" u on u.id = m."userId" where m."organizationId" = :org_id'
            ),
            {"org_id": org_id},
        )
    ).all()
    members = [{"email": r.email, "name": r.name, "role": r.role} for r in member_rows]

    rule_status_rows = (
        await session.execute(
            select(Rule.status, func.count()).where(Rule.org_id == org_id).group_by(Rule.status)
        )
    ).all()
    rules_by_status = {status: 0 for status in _RULE_STATUSES}
    for status_value, count in rule_status_rows:
        rules_by_status[status_value] = count

    open_gaps_count = (
        await session.execute(
            select(func.count(func.distinct(RuleGap.query_text))).where(RuleGap.org_id == org_id)
        )
    ).scalar_one()

    async def _connected(model) -> bool:
        row = (await session.execute(select(model.id).where(model.org_id == org_id))).first()
        return row is not None

    connectors = {
        "github": {"connected": await _connected(GithubConnection)},
        "slack": {"connected": await _connected(SlackConnection)},
        "zendesk": {"connected": await _connected(ZendeskConnection)},
        "intercom": {"connected": await _connected(IntercomConnection)},
        "notion": {"connected": await _connected(NotionConnection)},
        "linear": {"connected": await _connected(LinearConnection)},
    }

    mcp_keys_count = (
        await session.execute(
            select(func.count()).where(McpApiKey.org_id == org_id, McpApiKey.revoked_at.is_(None))
        )
    ).scalar_one()

    return {
        "id": org.id,
        "name": org_name,
        "plan_tier": org.plan_tier,
        "subscription_status": org.subscription_status,
        "trial_ends_at": org.trial_ends_at,
        "members": members,
        "rules_by_status": rules_by_status,
        "open_gaps_count": open_gaps_count,
        "connectors": connectors,
        "mcp_keys_count": mcp_keys_count,
    }


class PlanTierUpdate(BaseModel):
    plan_tier: str


@router.post("/orgs/{org_id}/plan-tier")
async def set_plan_tier(
    org_id: str,
    body: PlanTierUpdate,
    admin_email: str = Depends(require_platform_admin),
    session: AsyncSession = Depends(get_admin_session),
):
    """The one write gnt_admin can make -- see migration 0035. Column-
    scoped at the database level (plan_tier, subscription_status only);
    this endpoint only ever sets plan_tier, subscription_status is left
    alone here (that's a real Stripe-driven field, not a support toggle)."""
    if body.plan_tier not in ("base", "pro"):
        raise HTTPException(status_code=422, detail="plan_tier must be 'base' or 'pro'")

    org = (await session.execute(select(Org).where(Org.id == org_id))).scalar_one_or_none()
    if org is None:
        raise HTTPException(status_code=404, detail="org not found")

    org.plan_tier = body.plan_tier
    await session.commit()

    # Audited via server logs (no dedicated audit table for this yet) --
    # who changed what, for a role whose whole point is that a person, not
    # a script, is behind every write it makes.
    print(f"[platform-admin] {admin_email} set org {org_id} plan_tier -> {body.plan_tier}")

    return {"org_id": org_id, "plan_tier": body.plan_tier}

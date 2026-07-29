from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.auth.better_auth import OrgContext, get_current_org
from gnt.db.models import GithubConnection, McpApiKey, OnboardingEvent, SkillPack, SlackConnection
from gnt.db.session import get_session
from gnt.onboarding_metrics import RULES_APPROVED_MILESTONE

router = APIRouter(prefix="/v1", tags=["brain"])


@router.get("/brain/summary")
async def brain_summary(
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    pack_version = (
        await session.execute(select(func.max(SkillPack.version)).where(SkillPack.org_id == org.org_id))
    ).scalar_one()

    # Same predicate as list_mcp_keys (routers/settings.py): key_type == "mcp"
    # only, so a gnt-login cli-type key doesn't count as an MCP key here while
    # `gnt keys list` (which only ever shows key_type == "mcp" rows) shows
    # none. revoked_at IS NULL too, since a revoked key isn't usable by an
    # agent even though list_mcp_keys still lists it (with a "revoked" label).
    mcp_key_exists = (
        await session.execute(
            select(func.count())
            .select_from(McpApiKey)
            .where(
                McpApiKey.org_id == org.org_id,
                McpApiKey.key_type == "mcp",
                McpApiKey.revoked_at.is_(None),
            )
        )
    ).scalar_one() > 0

    slack_connected = (
        await session.execute(
            select(func.count()).select_from(SlackConnection).where(SlackConnection.org_id == org.org_id)
        )
    ).scalar_one() > 0

    return {
        "pack_version": pack_version,
        "slack_connected": slack_connected,
        "mcp_key_exists": mcp_key_exists,
    }


@router.get("/onboarding/status")
async def onboarding_status(
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    """This org's onboarding progress — "how close is this org to a working
    setup" — aggregated off onboarding_events (gnt/onboarding_metrics.py).
    Planned future ROI metering will read off the same table, so counts
    stay a flat event_type -> count map here rather than baking in today's
    five known types.

    connected_cli isn't an onboarding_event (gnt login has no event-log
    call site, unlike the Slack/GitHub connect routes and rule proposal) —
    it's read straight off mcp_api_keys instead. A CLI key, once minted,
    always stays a row here even if later revoked, so this answers "has
    this org ever completed gnt login", not "is a CLI key live right now".
    apps/web/components/onboarding-status.tsx polls this for the /welcome
    page's live step checklist.

    reached_five_rules_milestone is this product's "org reaches N approved
    rules in first session" success metric, N=5 — derived straight off
    the same counts, not a second query,
    since rules_approved already is that lifetime-cumulative count (see
    onboarding_metrics.RULES_APPROVED_MILESTONE for why that's an
    accurate proxy for "first session" here)."""
    result = await session.execute(
        select(OnboardingEvent.event_type, func.count())
        .where(OnboardingEvent.org_id == org.org_id)
        .group_by(OnboardingEvent.event_type)
    )
    counts = dict(result.all())

    connected_cli = (
        await session.execute(
            select(func.count())
            .select_from(McpApiKey)
            .where(McpApiKey.org_id == org.org_id, McpApiKey.key_type == "cli")
        )
    ).scalar_one() > 0

    rules_approved = counts.get("rule_approved", 0)

    # GitHub App migration — an org still on the legacy PAT flow
    # (a github_connections row with installation_id NULL) is flagged here
    # so `gnt status` can nudge them at `gnt connect github --upgrade`,
    # rather than requiring anyone to notice on their own that a materially
    # more secure connect flow now exists. Read straight off the row, not
    # counts.get("github_connected") above — that's a lifetime event count
    # (fires once per successful connect_github call) and has no notion of
    # which flow the CURRENT connection is on.
    github_connection = (
        await session.execute(select(GithubConnection).where(GithubConnection.org_id == org.org_id))
    ).scalar_one_or_none()
    github_needs_upgrade = github_connection is not None and github_connection.installation_id is None

    return {
        "connected_cli": connected_cli,
        "connected_slack": counts.get("slack_connected", 0) > 0,
        "connected_github": counts.get("github_connected", 0) > 0,
        "github_needs_upgrade": github_needs_upgrade,
        "rules_proposed": counts.get("rule_proposed", 0),
        "rules_approved": rules_approved,
        "reached_five_rules_milestone": rules_approved >= RULES_APPROVED_MILESTONE,
    }

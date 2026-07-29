from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.auth.better_auth import OrgContext, get_current_org
from gnt.db.session import get_session
from gnt.roi_summary import build_roi_summary

router = APIRouter(prefix="/v1/roi", tags=["roi"])


@router.get("/summary")
async def get_roi_summary(
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    """This org's ROI numbers (rules served, actions checked,
    blocked/needs_human counts, gap count, coverage growth) — the metrics
    that make the case gnt is worth keeping installed, the same
    aggregation workers/tasks_digest.py's weekly email sends
    (gnt.roi_summary.build_roi_summary), surfaced here for `gnt status` —
    see that CLI command for how this renders. Current 7-day window vs.
    the 7 days before it, so a customer sees the number AND whether it's
    moving, not just a point-in-time total."""
    summary = await build_roi_summary(session, org.org_id)
    roi = summary["roi"]

    return {
        "window_days": roi["window_days"],
        "rules_served": roi["current"]["rules_served"],
        "rules_served_prior": roi["prior"]["rules_served"],
        "actions_checked": roi["current"]["actions_checked"],
        "actions_checked_prior": roi["prior"]["actions_checked"],
        "actions_blocked": roi["current"]["actions_blocked"],
        "actions_blocked_prior": roi["prior"]["actions_blocked"],
        "actions_needs_human": roi["current"]["actions_needs_human"],
        "actions_needs_human_prior": roi["prior"]["actions_needs_human"],
        "gap_count": summary["gaps"]["current"],
        "gap_count_prior": summary["gaps"]["prior"],
        "stale_due_count": summary["stale_due_count"],
    }

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.auth.better_auth import OrgContext, get_current_org
from gnt.db.session import get_session
from gnt.gap_tracking import list_top_gaps

router = APIRouter(prefix="/v1/gaps", tags=["gaps"])

_MAX_LIMIT = 100


@router.get("")
async def get_gaps(
    limit: int = 20,
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    """This org's top uncovered queries — search_rules calls that came back
    empty, and check_action calls that escalated to needs_human specifically
    because no rule covers the action (see gap_tracking.py). Backs `gnt gaps`."""
    limit = max(1, min(limit, _MAX_LIMIT))
    return await list_top_gaps(session, org.org_id, limit=limit)

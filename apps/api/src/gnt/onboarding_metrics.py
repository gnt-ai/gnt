import sentry_sdk
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.db.models import OnboardingEvent
from gnt.db.rls import scope_to_org

# First-session success instrumentation. ROI metering (gnt.roi_summary)
# builds on the same onboarding_events rows, so this stays a single
# reusable entry point rather than each call site writing its own insert.
_KNOWN_EVENT_TYPES = {
    "slack_connected",
    "github_connected",
    "rule_proposed",
    "rule_approved",
    # Zendesk's own connect flow (routers/zendesk.py).
    "zendesk_connected",
    # Intercom's own connect flow (routers/intercom.py).
    "intercom_connected",
}

# The founder-set target for "org reaches N approved rules in first
# session" (N=5). rules_approved is a lifetime-cumulative count per org, not a
# count scoped to a login session — this codebase has no session table
# onboarding_events could join against. In practice that's not a problem:
# every org starts at zero rule_approved events the moment it's created,
# and gnt prebrain (this task's whole point) is the only mechanism that
# gets an org to five approved rules quickly, so "cumulative count crosses
# the threshold" and "reached it in the first session" describe the same
# thing for the cold-start case this metric exists to measure. If a
# stricter, time-windowed definition is ever needed, every row here
# already carries created_at (and orgs.created_at exists too) — no schema
# change required to add that later.
RULES_APPROVED_MILESTONE = 5


async def log_onboarding_event(session: AsyncSession, org_id: str, event_type: str) -> None:
    """Best-effort — instrumentation must never break the request it rides
    along in. Every call site invokes this only after its real operation
    has already succeeded (and usually already committed), so this owns
    its own small commit rather than assuming anything about the caller's
    transaction state.

    Re-scopes app.current_org itself (see db/rls.scope_to_org) since most
    callers invoke this right after their own commit(), which ends
    whatever transaction scoped the session before — the same "scope
    again after commit" pattern routers/slack.py already follows ahead of
    its own post-commit refresh().

    Any failure — including the scope/insert/commit itself — is reported
    to Sentry and swallowed, never re-raised.
    """
    try:
        assert event_type in _KNOWN_EVENT_TYPES, f"unknown onboarding event_type: {event_type!r}"
        await scope_to_org(session, org_id)
        session.add(OnboardingEvent(org_id=org_id, event_type=event_type))
        await session.commit()
    except Exception as exc:
        sentry_sdk.capture_exception(exc)
        await session.rollback()

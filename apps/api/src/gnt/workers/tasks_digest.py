"""Weekly digest email (fix-plan-v2 item 10 — ROI metering and the weekly
number). This is the plan's own "painkiller acceptance gate" made real: a
customer org sees, in this email, how many times agents consulted rules,
how many actions were blocked/flagged, and which queries found no rule —
aggregated by gnt.roi_summary.build_roi_summary off roi_counters
(gnt.roi_metrics, fed by mcp_server/server.py's search_rules/get_rule/
check_action) and rule_gaps (gnt.gap_tracking, fix-plan-v2 item 8), plus
item 9's staleness signal (gnt.staleness) so this is the one place the
plan's own text originally pointed that prompt at (see routers/rules.py's
get_rules_due_for_revalidation docstring: "wire it into the digest once
item 10 exists rather than building a second parallel version of it").

Follows workers/tasks_staleness.py's reference two-tier session pattern
for every cron job in this codebase (see that module's own docstring for
the full reasoning): enumerate org ids through get_cron_sessionmaker()
(BYPASSRLS, the narrow gnt_cron exemption), then do every actual per-org
read (and the recipient lookup, and the send) through a normal
scope_to_org'd session, one org at a time, never a single cross-org
statement.

Email sending degrades gracefully and independently of everything else
here: gnt.email.send_weekly_digest is a no-op-and-log when RESEND_API_KEY
isn't set (true today on Railway's api/worker services — see config.py),
and gnt.org_contacts.get_digest_recipients degrades to an empty list on
any failure reading Better Auth's own tables (unverified against a live
DB as of this module's introduction — see that module's own docstring).
Neither failure mode raises, so a misconfigured or not-yet-configured org
never breaks another org's run, and the digest job's absence of email
capability never touches the rest of this plan item's non-email surface
(`gnt status --org`, GET /v1/roi/summary) at all — those read roi_counters
directly, nothing here.
"""

import json
from typing import Any

import sentry_sdk
from sqlalchemy import select

from gnt.db.models import Org
from gnt.db.rls import scope_to_org
from gnt.db.session import get_cron_sessionmaker, get_sessionmaker
from gnt.email import send_weekly_digest
from gnt.org_contacts import get_digest_recipients
from gnt.roi_summary import build_roi_summary


async def send_all_weekly_digests(ctx: dict[str, Any]) -> None:
    """arq cron entrypoint (see worker.py's cron_jobs). Enumerates every
    org, then builds and sends that org's own digest — see module
    docstring for why enumeration and the per-org work use two different
    sessions/roles."""
    cron_session_factory = get_cron_sessionmaker()
    async with cron_session_factory() as session:
        org_ids = [row[0] for row in (await session.execute(select(Org.id))).all()]

    for org_id in org_ids:
        # One org's failure (a bad recipient lookup, a DB hiccup building
        # its summary) must never suppress every other org's digest — same
        # per-org isolation tasks_zendesk.py/tasks_intercom.py already give
        # their own sync loops.
        try:
            await send_weekly_digest_for_org(org_id)
        except Exception as exc:
            sentry_sdk.capture_exception(exc)


async def send_weekly_digest_for_org(org_id: str) -> None:
    """The per-org unit of work send_all_weekly_digests loops over —
    mirrors tasks_staleness.py's compute_staleness_for_org /
    tasks_contradictions.py's sweep_contradictions_for_org shape: takes an
    org_id, opens its own scope_to_org'd session, does the work. An org
    with no owner/admin verified email on file has nowhere to send a
    digest, so it's skipped outright (logged, not an error) — plenty of
    orgs won't resolve a recipient, especially before RESEND_API_KEY is
    even configured. Looks the recipients up BEFORE aggregating, not
    after — no reason to spend three extra queries building a summary
    nobody will ever read."""
    session_factory = get_sessionmaker()
    async with session_factory() as session:
        await scope_to_org(session, org_id)

        recipients = await get_digest_recipients(session, org_id)
        if not recipients:
            print(json.dumps({"event": "weekly_digest_skipped", "org_id": org_id, "reason": "no recipients"}))
            return

        summary = await build_roi_summary(session, org_id)
        await send_weekly_digest(recipients, org_id, summary)

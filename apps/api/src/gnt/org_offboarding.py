"""fix-plan-v3 tier 0 item 0.3 (C4) — org offboarding.

Two halves, both org-scoped:

- export_org_data: a real, downloadable snapshot of what an org is about
  to lose — rules with their full audit history (from apps/store, the
  actual system of record for rules since the Phase 4 migration — see
  db/models.py's Rule docstring), plus every other org-scoped signal that
  has real analytical/historical value (gaps, staleness snapshots,
  calibration events, contradiction findings, ROI counters, onboarding
  events). Deliberately excludes anything secret — key/token hashes,
  encrypted PATs, encrypted bot tokens never leave Postgres, not even
  inside an export bundle handed to the org that owns them; connection
  rows are exported as metadata only (routers/settings.py's own
  _serialize_key/_serialize_webhook_token convention). Also excludes
  skill_packs/skill_files — compiled build artifacts regenerable from
  rules, not source data worth exporting.

- delete_org_postgres_data: hard-deletes every row in every table that
  carries an org_id column, full stop. The table list below is the
  authoritative set as of this writing — confirmed by grepping
  `org_id: Mapped` across db/models.py, not carried over from memory.
  Deliberately includes the legacy `rules`/`rule_audit_log` tables even
  though nothing writes to them anymore post-Phase-4 (see Rule's
  docstring) and `ingest_events` even though its only writers were
  retired: pre-migration orgs can have real historical rows sitting in
  either, and leaving them behind after "offboarding" would be exactly
  the kind of data-leak-after-deletion this item exists to prevent.

Both halves call scope_to_org themselves (defense-in-depth, same
discipline as gap_tracking.py/contradiction_findings.py) even though
routers/org_admin.py's endpoints already run inside a request already
scoped by get_current_org — and every delete/select below is *also*
filtered by an explicit org_id predicate regardless of whether the table
has an RLS policy, since four of these tables (mcp_api_keys,
webhook_tokens, slack_connections, github_connections) are deliberately
excluded from RLS (see migrations 0007/0011/0024's own docstrings — the
auth-bootstrap lookups on those tables can't be org-scoped by
definition), so the explicit filter is the ONLY tenant boundary they
have.

The org's own `orgs` row is deliberately NOT deleted here — it isn't
enumerated in the plan's own list ("rules mirror, gaps, ROI counters,
findings, keys, and logs"), and dropping it would reset trial_ends_at on
next ensure_org, which is a founder call (free-trial-reset surface) well
outside this item's scope.
"""

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.db.models import (
    CalibrationEvent,
    ContradictionFinding,
    GithubConnection,
    IngestEvent,
    McpApiKey,
    OnboardingEvent,
    Rule,
    RuleAuditLog,
    RuleGap,
    RuleStaleness,
    RoiCounter,
    SkillFile,
    SkillPack,
    SlackConnection,
    WebhookToken,
)
from gnt.db.rls import scope_to_org
from gnt.store_client import get_audit_trail, list_rules


def _iso(value: datetime | Any | None) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


async def export_org_data(session: AsyncSession, org_id: str) -> dict[str, Any]:
    """A real, complete-enough-to-be-honest JSON export — not a fancy
    export UI, just every org-scoped fact worth keeping a record of,
    assembled fresh at request time (never cached, since it has to
    reflect exactly what's about to be deleted)."""
    await scope_to_org(session, org_id)

    rules = await list_rules(org_id)
    rules_with_history = []
    for rule in rules:
        audit_trail = await get_audit_trail(org_id, rule["slug"])
        rules_with_history.append({**rule, "audit_trail": audit_trail})

    gaps = (
        await session.execute(
            select(RuleGap).where(RuleGap.org_id == org_id).order_by(RuleGap.created_at)
        )
    ).scalars().all()
    staleness = (
        await session.execute(
            select(RuleStaleness).where(RuleStaleness.org_id == org_id).order_by(RuleStaleness.rule_slug)
        )
    ).scalars().all()
    calibration_events = (
        await session.execute(
            select(CalibrationEvent)
            .where(CalibrationEvent.org_id == org_id)
            .order_by(CalibrationEvent.created_at)
        )
    ).scalars().all()
    contradiction_findings = (
        await session.execute(
            select(ContradictionFinding)
            .where(ContradictionFinding.org_id == org_id)
            .order_by(ContradictionFinding.filed_at)
        )
    ).scalars().all()
    roi_counters = (
        await session.execute(
            select(RoiCounter).where(RoiCounter.org_id == org_id).order_by(RoiCounter.day)
        )
    ).scalars().all()
    onboarding_events = (
        await session.execute(
            select(OnboardingEvent)
            .where(OnboardingEvent.org_id == org_id)
            .order_by(OnboardingEvent.created_at)
        )
    ).scalars().all()
    mcp_keys = (
        await session.execute(
            select(McpApiKey).where(McpApiKey.org_id == org_id).order_by(McpApiKey.created_at)
        )
    ).scalars().all()
    webhook_tokens = (
        await session.execute(
            select(WebhookToken).where(WebhookToken.org_id == org_id).order_by(WebhookToken.created_at)
        )
    ).scalars().all()
    slack_connection = (
        await session.execute(select(SlackConnection).where(SlackConnection.org_id == org_id))
    ).scalar_one_or_none()
    github_connection = (
        await session.execute(select(GithubConnection).where(GithubConnection.org_id == org_id))
    ).scalar_one_or_none()

    return {
        "org_id": org_id,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "rules": rules_with_history,
        "rule_gaps": [
            {"tool": g.tool, "query_text": g.query_text, "created_at": _iso(g.created_at)} for g in gaps
        ],
        "rule_staleness": [
            {
                "rule_slug": s.rule_slug,
                "title": s.title,
                "age_days": s.age_days,
                "freshness_score": s.freshness_score,
                "is_stale": s.is_stale,
                "computed_at": _iso(s.computed_at),
            }
            for s in staleness
        ],
        "calibration_events": [
            {
                "event_type": c.event_type,
                "rule_slug": c.rule_slug,
                "pr_number": c.pr_number,
                "age_days": c.age_days,
                "detail": c.detail,
                "created_at": _iso(c.created_at),
            }
            for c in calibration_events
        ],
        "contradiction_findings": [
            {
                "rule_slug_a": f.rule_slug_a,
                "rule_slug_b": f.rule_slug_b,
                "relation": f.relation,
                "issue_number": f.issue_number,
                "issue_url": f.issue_url,
                "filed_at": _iso(f.filed_at),
            }
            for f in contradiction_findings
        ],
        "roi_counters": [
            {
                "day": _iso(r.day),
                "rules_served": r.rules_served,
                "actions_checked": r.actions_checked,
                "actions_blocked": r.actions_blocked,
                "actions_needs_human": r.actions_needs_human,
            }
            for r in roi_counters
        ],
        "onboarding_events": [
            {"event_type": e.event_type, "created_at": _iso(e.created_at)} for e in onboarding_events
        ],
        # Metadata only — never key_hash/token_hash/pat_encrypted/
        # webhook_secret_encrypted/bot_token_encrypted. Same convention as
        # routers/settings.py's _serialize_key/_serialize_webhook_token and
        # routers/github.py's _serialize: a secret is write-only from the
        # API's perspective, and an offboarding export is not an exception.
        "mcp_api_keys": [
            {
                "name": k.name,
                "key_type": k.key_type,
                "created_at": _iso(k.created_at),
                "last_used_at": _iso(k.last_used_at),
                "revoked_at": _iso(k.revoked_at),
            }
            for k in mcp_keys
        ],
        "webhook_tokens": [
            {
                "name": t.name,
                "created_at": _iso(t.created_at),
                "last_used_at": _iso(t.last_used_at),
                "revoked_at": _iso(t.revoked_at),
            }
            for t in webhook_tokens
        ],
        "slack_connection": (
            None
            if slack_connection is None
            else {
                "team_id": slack_connection.team_id,
                "team_name": slack_connection.team_name,
                "installed_by_user_id": slack_connection.installed_by_user_id,
                "created_at": _iso(slack_connection.created_at),
            }
        ),
        "github_connection": (
            None
            if github_connection is None
            else {
                "repo_url": github_connection.repo_url,
                "default_branch": github_connection.default_branch,
                "installed_by_user_id": github_connection.installed_by_user_id,
                "created_at": _iso(github_connection.created_at),
            }
        ),
    }


async def delete_org_postgres_data(session: AsyncSession, org_id: str) -> dict[str, int]:
    """Hard-deletes every org-scoped Postgres row for org_id. Returns a
    {table_name: rows_deleted} map so callers (and this item's own tests)
    can verify every table was actually touched, not just trust the first
    one and assume the rest followed.

    Deletion order matters for exactly two FK edges, both handled
    explicitly below: skill_files -> skill_packs (no ON DELETE CASCADE at
    the DB level — see migration 0001) and rule_audit_log -> rules (same).
    Every other table here has no FK from another org-scoped table, so
    order between them is arbitrary."""
    await scope_to_org(session, org_id)
    counts: dict[str, int] = {}

    skill_files_result = await session.execute(
        delete(SkillFile).where(
            SkillFile.pack_id.in_(select(SkillPack.id).where(SkillPack.org_id == org_id))
        )
    )
    counts["skill_files"] = skill_files_result.rowcount or 0

    counts["rule_audit_log"] = (
        await session.execute(delete(RuleAuditLog).where(RuleAuditLog.org_id == org_id))
    ).rowcount or 0
    # Legacy Postgres-side rules table (see this module's own docstring —
    # nothing writes here post-Phase-4, real rules live in apps/store).
    counts["rules"] = (await session.execute(delete(Rule).where(Rule.org_id == org_id))).rowcount or 0
    counts["skill_packs"] = (
        await session.execute(delete(SkillPack).where(SkillPack.org_id == org_id))
    ).rowcount or 0
    counts["ingest_events"] = (
        await session.execute(delete(IngestEvent).where(IngestEvent.org_id == org_id))
    ).rowcount or 0
    counts["onboarding_events"] = (
        await session.execute(delete(OnboardingEvent).where(OnboardingEvent.org_id == org_id))
    ).rowcount or 0
    counts["rule_gaps"] = (
        await session.execute(delete(RuleGap).where(RuleGap.org_id == org_id))
    ).rowcount or 0
    counts["rule_staleness"] = (
        await session.execute(delete(RuleStaleness).where(RuleStaleness.org_id == org_id))
    ).rowcount or 0
    counts["calibration_events"] = (
        await session.execute(delete(CalibrationEvent).where(CalibrationEvent.org_id == org_id))
    ).rowcount or 0
    counts["contradiction_findings"] = (
        await session.execute(delete(ContradictionFinding).where(ContradictionFinding.org_id == org_id))
    ).rowcount or 0
    counts["roi_counters"] = (
        await session.execute(delete(RoiCounter).where(RoiCounter.org_id == org_id))
    ).rowcount or 0
    counts["mcp_api_keys"] = (
        await session.execute(delete(McpApiKey).where(McpApiKey.org_id == org_id))
    ).rowcount or 0
    counts["webhook_tokens"] = (
        await session.execute(delete(WebhookToken).where(WebhookToken.org_id == org_id))
    ).rowcount or 0
    counts["slack_connections"] = (
        await session.execute(delete(SlackConnection).where(SlackConnection.org_id == org_id))
    ).rowcount or 0
    counts["github_connections"] = (
        await session.execute(delete(GithubConnection).where(GithubConnection.org_id == org_id))
    ).rowcount or 0

    return counts

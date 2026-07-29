"""roi_counters — per-org daily usage counters for ROI metering and the
weekly number. See gnt.roi_metrics for the read/write
helpers and mcp_server/server.py for the hot-path call sites that
increment this (search_rules, get_rule, check_action).

One row per (org_id, day), upserted throughout the day rather than
append-only — the hot MCP-serving path only ever does a cheap "add N to
this counter" UPDATE (or a single INSERT the first time a given org sees
traffic on a given day), never a per-call INSERT that would make this
table grow at MCP-call volume. Daily buckets, not a single running total
per org, so the weekly digest (workers/tasks_digest.py) and `gnt status`
can both sum an arbitrary trailing window (this week vs. last week) without
a separate snapshot/history mechanism.

Genuinely org-scoped with no auth-bootstrap lookup need, same reasoning as
migration 0019's rule_gaps, 0020's rule_staleness, 0021's
calibration_events, and 0022's contradiction_findings, so RLS follows the
same pattern.

Revision ID: 0023
Revises: 0022
Create Date: 2026-07-17
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "roi_counters",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("rules_served", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("actions_checked", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("actions_blocked", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("actions_needs_human", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("org_id", "day", name="uq_roi_counters_org_day"),
    )
    op.create_index("ix_roi_counters_org_id", "roi_counters", ["org_id"])

    op.execute("ALTER TABLE roi_counters ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE roi_counters FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON roi_counters "
        "USING (org_id = current_setting('app.current_org', true)) "
        "WITH CHECK (org_id = current_setting('app.current_org', true))"
    )


def downgrade() -> None:
    op.execute("DROP POLICY tenant_isolation ON roi_counters")
    op.execute("ALTER TABLE roi_counters NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE roi_counters DISABLE ROW LEVEL SECURITY")
    op.drop_table("roi_counters")

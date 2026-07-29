"""Intercom connector — a continuous server-side
sync, same architecture as Zendesk's (see
workers/tasks_intercom.py's module docstring). Three tables:

intercom_connections — the per-org credential (a single encrypted access
token; no subdomain/agent-email columns the way zendesk_connections has,
since Intercom has no per-customer subdomain — every request goes to the
same api.intercom.io host). RLS-eligible, unlike slack_connections/
github_connections: neither of those can have RLS because something else
has to look the row up by an external id BEFORE an org_id is known (a
Slack team_id, a GitHub webhook's repo_url). Intercom has no equivalent
inbound webhook this connector depends on — this is a pull-based sync,
always read by org_id inside an already-scoped session — so the standard
tenant_isolation policy applies here same as
contradiction_findings/roi_counters/llm_usage.

intercom_sync_states — one row per org, upserted every sync run (sync-
status health surface). Also RLS-eligible for the same reason.

intercom_processed_items — dedup log for the nightly sync, same shape and
same RLS eligibility as staleness_refresh_proposals/contradiction_findings.

Revision ID: 0030
Revises: 0029
Create Date: 2026-07-19
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0030"
down_revision = "0029"
branch_labels = None
depends_on = None

_RLS_TABLES = ("intercom_connections", "intercom_sync_states", "intercom_processed_items")


def upgrade() -> None:
    op.create_table(
        "intercom_connections",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False, unique=True),
        sa.Column("access_token_encrypted", sa.String(), nullable=False),
        sa.Column("installed_by_user_id", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_intercom_connections_org_id", "intercom_connections", ["org_id"])

    op.create_table(
        "intercom_sync_states",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False, unique=True),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.String(), nullable=True),
        sa.Column("last_error_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("items_scanned_last_run", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("candidates_proposed_last_run", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_intercom_sync_states_org_id", "intercom_sync_states", ["org_id"])

    op.create_table(
        "intercom_processed_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("item_type", sa.String(), nullable=False),
        sa.Column("item_id", sa.String(), nullable=False),
        sa.Column("content_fingerprint", sa.String(), nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint(
            "org_id", "item_type", "item_id", "content_fingerprint", name="uq_intercom_processed_items"
        ),
    )
    op.create_index("ix_intercom_processed_items_org_id", "intercom_processed_items", ["org_id"])

    for table in _RLS_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY tenant_isolation ON {table} "
            "USING (org_id = current_setting('app.current_org', true)) "
            "WITH CHECK (org_id = current_setting('app.current_org', true))"
        )


def downgrade() -> None:
    for table in reversed(_RLS_TABLES):
        op.execute(f"DROP POLICY tenant_isolation ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")

    op.drop_table("intercom_processed_items")
    op.drop_table("intercom_sync_states")
    op.drop_table("intercom_connections")

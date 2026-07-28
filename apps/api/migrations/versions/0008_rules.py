"""rules + rule_audit_log — the unified rules model (execution plan Phase
1). Built additively alongside the existing decision_rules/knowledge_units
tables, which are untouched here. RLS follows the same pattern as
migration 0007 (both tables are genuinely org-scoped with no auth-
bootstrap lookup need, unlike mcp_api_keys/slack_connections).

Revision ID: 0008
Revises: 0007
Create Date: 2026-07-13
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "rules",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("body", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="draft"),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0.7"),
        sa.Column("owner_user_id", sa.String(), nullable=False),
        sa.Column(
            "source_citations",
            postgresql.JSONB(),
            nullable=False,
            server_default="[]",
        ),
        sa.Column("last_validated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("superseded_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("previous_version_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("approved_by", sa.String(), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_foreign_key(
        "fk_rules_superseded_by", "rules", "rules", ["superseded_by"], ["id"]
    )
    op.create_foreign_key(
        "fk_rules_previous_version_id", "rules", "rules", ["previous_version_id"], ["id"]
    )
    op.create_index("ix_rules_org_id", "rules", ["org_id"])
    op.create_index("ix_rules_org_status", "rules", ["org_id", "status"])

    op.create_table(
        "rule_audit_log",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("rule_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("rules.id"), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("actor_user_id", sa.String(), nullable=False),
        sa.Column("before", postgresql.JSONB(), nullable=True),
        sa.Column("after", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_rule_audit_log_org_id", "rule_audit_log", ["org_id"])
    op.create_index("ix_rule_audit_log_rule_id", "rule_audit_log", ["rule_id"])

    for table in ("rules", "rule_audit_log"):
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY tenant_isolation ON {table} "
            f"USING (org_id = current_setting('app.current_org', true)) "
            f"WITH CHECK (org_id = current_setting('app.current_org', true))"
        )


def downgrade() -> None:
    for table in ("rule_audit_log", "rules"):
        op.execute(f"DROP POLICY tenant_isolation ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")

    op.drop_table("rule_audit_log")
    op.drop_table("rules")

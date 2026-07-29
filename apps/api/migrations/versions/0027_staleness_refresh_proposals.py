"""staleness_refresh_proposals — dedup log for the staleness-sweep side of
rule refresh (staleness sweeps re-check flagged rules against fresh source
material and open refresh-or-deprecate PRs). Same
role for that sweep as migration 0022's contradiction_findings plays for
the sibling contradiction sweep. Genuinely org-scoped with no
auth-bootstrap lookup need, same reasoning as that table, so RLS follows
the same pattern.

Revision ID: 0027
Revises: 0026
Create Date: 2026-07-18
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "staleness_refresh_proposals",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("rule_slug", sa.String(), nullable=False),
        sa.Column("reason", sa.String(), nullable=False),
        sa.Column("source_path", sa.String(), nullable=False),
        sa.Column("content_fingerprint", sa.String(), nullable=False),
        sa.Column("new_rule_slug", sa.String(), nullable=False),
        sa.Column("pr_number", sa.Integer(), nullable=False),
        sa.Column("pr_url", sa.String(), nullable=False),
        sa.Column("proposed_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint(
            "org_id",
            "rule_slug",
            "reason",
            "content_fingerprint",
            name="uq_staleness_refresh_org_rule_reason_fingerprint",
        ),
    )
    op.create_index("ix_staleness_refresh_proposals_org_id", "staleness_refresh_proposals", ["org_id"])

    op.execute("ALTER TABLE staleness_refresh_proposals ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE staleness_refresh_proposals FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON staleness_refresh_proposals "
        "USING (org_id = current_setting('app.current_org', true)) "
        "WITH CHECK (org_id = current_setting('app.current_org', true))"
    )


def downgrade() -> None:
    op.execute("DROP POLICY tenant_isolation ON staleness_refresh_proposals")
    op.execute("ALTER TABLE staleness_refresh_proposals NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE staleness_refresh_proposals DISABLE ROW LEVEL SECURITY")
    op.drop_table("staleness_refresh_proposals")

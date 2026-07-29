"""rule_staleness — nightly staleness snapshot so staleness can be surfaced
at serving time. Genuinely org-scoped with no
auth-bootstrap lookup need, same reasoning as migration 0019's rule_gaps,
so RLS follows the same pattern.

Revision ID: 0020
Revises: 0019
Create Date: 2026-07-17
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "rule_staleness",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("rule_slug", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("age_days", sa.Float(), nullable=False),
        sa.Column("freshness_score", sa.Float(), nullable=False),
        sa.Column("is_stale", sa.Boolean(), nullable=False),
        sa.Column("computed_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("org_id", "rule_slug", name="uq_rule_staleness_org_rule"),
    )
    op.create_index("ix_rule_staleness_org_id", "rule_staleness", ["org_id"])
    op.create_index("ix_rule_staleness_org_stale", "rule_staleness", ["org_id", "is_stale"])

    op.execute("ALTER TABLE rule_staleness ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE rule_staleness FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON rule_staleness "
        "USING (org_id = current_setting('app.current_org', true)) "
        "WITH CHECK (org_id = current_setting('app.current_org', true))"
    )


def downgrade() -> None:
    op.execute("DROP POLICY tenant_isolation ON rule_staleness")
    op.execute("ALTER TABLE rule_staleness NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE rule_staleness DISABLE ROW LEVEL SECURITY")
    op.drop_table("rule_staleness")

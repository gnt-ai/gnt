"""contradiction_findings — dedup log for the continuous contradiction
sweeps. Genuinely org-scoped with no auth-bootstrap lookup
need, same reasoning as migration 0019's rule_gaps, 0020's rule_staleness,
and 0021's calibration_events, so RLS follows the same pattern.

Revision ID: 0022
Revises: 0021
Create Date: 2026-07-18
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "contradiction_findings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("rule_slug_a", sa.String(), nullable=False),
        sa.Column("rule_slug_b", sa.String(), nullable=False),
        sa.Column("relation", sa.String(), nullable=False),
        sa.Column("issue_number", sa.Integer(), nullable=False),
        sa.Column("issue_url", sa.String(), nullable=False),
        sa.Column("filed_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("org_id", "rule_slug_a", "rule_slug_b", name="uq_contradiction_findings_org_pair"),
    )
    op.create_index("ix_contradiction_findings_org_id", "contradiction_findings", ["org_id"])

    op.execute("ALTER TABLE contradiction_findings ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE contradiction_findings FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON contradiction_findings "
        "USING (org_id = current_setting('app.current_org', true)) "
        "WITH CHECK (org_id = current_setting('app.current_org', true))"
    )


def downgrade() -> None:
    op.execute("DROP POLICY tenant_isolation ON contradiction_findings")
    op.execute("ALTER TABLE contradiction_findings NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE contradiction_findings DISABLE ROW LEVEL SECURITY")
    op.drop_table("contradiction_findings")

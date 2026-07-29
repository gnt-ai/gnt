"""calibration_events — calibration-signal log used to label confidence/
decay as uncalibrated and start collecting calibration data. Genuinely
org-scoped with no auth-bootstrap lookup need, same
reasoning as migration 0019's rule_gaps and 0020's rule_staleness, so RLS
follows the same pattern.

Revision ID: 0021
Revises: 0020
Create Date: 2026-07-17
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "calibration_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("rule_slug", sa.String(), nullable=True),
        sa.Column("pr_number", sa.Integer(), nullable=True),
        sa.Column("age_days", sa.Float(), nullable=True),
        sa.Column("detail", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_calibration_events_org_id", "calibration_events", ["org_id"])
    op.create_index("ix_calibration_events_org_type", "calibration_events", ["org_id", "event_type"])
    op.create_index(
        "ix_calibration_events_org_rule_pr", "calibration_events", ["org_id", "rule_slug", "pr_number"]
    )

    op.execute("ALTER TABLE calibration_events ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE calibration_events FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON calibration_events "
        "USING (org_id = current_setting('app.current_org', true)) "
        "WITH CHECK (org_id = current_setting('app.current_org', true))"
    )


def downgrade() -> None:
    op.execute("DROP POLICY tenant_isolation ON calibration_events")
    op.execute("ALTER TABLE calibration_events NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE calibration_events DISABLE ROW LEVEL SECURITY")
    op.drop_table("calibration_events")

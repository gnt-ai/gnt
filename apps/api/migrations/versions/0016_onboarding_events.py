"""onboarding_events — funnel-tracking table for first-session success
instrumentation. One row per milestone an org
hits on the way to a working setup (slack_connected, github_connected,
capture, rule_proposed, rule_approved); routers/brain.py's
/v1/onboarding/status aggregates counts off it. Genuinely org-scoped with
no auth-bootstrap lookup need, so RLS follows the same pattern as
migration 0008's rules/rule_audit_log.

Revision ID: 0016
Revises: 0015
Create Date: 2026-07-16
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "onboarding_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_onboarding_events_org_id", "onboarding_events", ["org_id"])
    op.create_index(
        "ix_onboarding_events_org_type", "onboarding_events", ["org_id", "event_type"]
    )

    op.execute("ALTER TABLE onboarding_events ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE onboarding_events FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON onboarding_events "
        "USING (org_id = current_setting('app.current_org', true)) "
        "WITH CHECK (org_id = current_setting('app.current_org', true))"
    )


def downgrade() -> None:
    op.execute("DROP POLICY tenant_isolation ON onboarding_events")
    op.execute("ALTER TABLE onboarding_events NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE onboarding_events DISABLE ROW LEVEL SECURITY")
    op.drop_table("onboarding_events")

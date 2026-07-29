"""rule_gaps — coverage-gap log backing gap-aware answers.
One row per search_rules/check_action call that surfaced a "no approved
rule covers this" signal; `gnt gaps` aggregates these to show an org its
top uncovered queries. Genuinely org-scoped with no auth-bootstrap lookup
need (same reasoning as migration 0016's onboarding_events), so RLS
follows the same pattern.

Revision ID: 0019
Revises: 0018
Create Date: 2026-07-17
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "rule_gaps",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("tool", sa.String(), nullable=False),
        sa.Column("query_text", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_rule_gaps_org_id", "rule_gaps", ["org_id"])
    op.create_index("ix_rule_gaps_org_tool", "rule_gaps", ["org_id", "tool"])

    op.execute("ALTER TABLE rule_gaps ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE rule_gaps FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON rule_gaps "
        "USING (org_id = current_setting('app.current_org', true)) "
        "WITH CHECK (org_id = current_setting('app.current_org', true))"
    )


def downgrade() -> None:
    op.execute("DROP POLICY tenant_isolation ON rule_gaps")
    op.execute("ALTER TABLE rule_gaps NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE rule_gaps DISABLE ROW LEVEL SECURITY")
    op.drop_table("rule_gaps")

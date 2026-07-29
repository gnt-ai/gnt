"""llm_usage / llm_usage_global — a per-org monthly LLM spend quota plus a
global aggregate circuit breaker, needed before any feature could make
uncapped, unbudgeted LLM calls on the org's behalf. See gnt.llm_quota for
the read/enforce/record helpers and the
three call sites it gates: action_check.py's judge_action,
pipeline/rule_conflict.py's judge_conflict (propose_rule and the nightly
contradiction sweep both call it).

llm_usage: one row per (org_id, month), same atomic upsert shape as
migration 0023's roi_counters. Genuinely org-scoped with org_id known
upfront from get_current_org/require_org_id (unlike mcp_api_keys/
webhook_tokens, which resolve an org from an opaque token and can't be
RLS-scoped until that lookup completes) — RLS follows the same pattern
migration 0023 already established.

llm_usage_global: one row per month, no org_id at all — deliberately not
tenant data, so no RLS policy applies (the opposite reason migration
0024's webhook_tokens has no RLS: that table's org isn't resolved yet,
this table's org never applies).

Revision ID: 0026
Revises: 0025
Create Date: 2026-07-18
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "llm_usage",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("month", sa.Date(), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("estimated_cost_micros", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("org_id", "month", name="uq_llm_usage_org_month"),
    )
    op.create_index("ix_llm_usage_org_id", "llm_usage", ["org_id"])

    op.execute("ALTER TABLE llm_usage ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE llm_usage FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON llm_usage "
        "USING (org_id = current_setting('app.current_org', true)) "
        "WITH CHECK (org_id = current_setting('app.current_org', true))"
    )

    op.create_table(
        "llm_usage_global",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("month", sa.Date(), nullable=False, unique=True),
        sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("estimated_cost_micros", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("alert_50_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("alert_80_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("alert_100_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("llm_usage_global")

    op.execute("DROP POLICY tenant_isolation ON llm_usage")
    op.execute("ALTER TABLE llm_usage NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE llm_usage DISABLE ROW LEVEL SECURITY")
    op.drop_table("llm_usage")

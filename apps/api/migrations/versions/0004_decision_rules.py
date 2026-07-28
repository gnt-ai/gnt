"""decision_rules + rule_review_cases — structured conditional policy rules,
parallel to knowledge_units/conflicts. Timestamps are TIMESTAMPTZ from the
start (see 0003's docstring for why naive DateTime broke asyncpg writes).

Revision ID: 0004
Revises: 0003
Create Date: 2026-07-10
"""

import pgvector.sqlalchemy
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

_DIM = 1024


def upgrade() -> None:
    op.create_table(
        "decision_rules",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("domain", sa.String(), nullable=False),
        sa.Column("condition", sa.String(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("exception", sa.String(), nullable=True),
        sa.Column("source_quote", sa.String(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0.7"),
        sa.Column("status", sa.String(), nullable=False, server_default="pending_review"),
        sa.Column(
            "source_event_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ingest_events.id"),
            nullable=False,
        ),
        sa.Column("contributor_hash", sa.String(), nullable=False),
        sa.Column(
            "superseded_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("decision_rules.id"),
            nullable=True,
        ),
        sa.Column("embedding", pgvector.sqlalchemy.Vector(_DIM), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reviewed_by", sa.String(), nullable=True),
        sa.Column("rejection_reason", sa.String(), nullable=True),
    )
    op.create_index("ix_decision_rules_org_id", "decision_rules", ["org_id"])
    op.create_index("ix_decision_rules_domain", "decision_rules", ["domain"])
    op.create_index(
        "ix_decision_rules_org_domain_status", "decision_rules", ["org_id", "domain", "status"]
    )
    op.execute(
        "CREATE INDEX ix_decision_rules_embedding_hnsw ON decision_rules "
        "USING hnsw (embedding vector_cosine_ops)"
    )

    op.create_table(
        "rule_review_cases",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column(
            "new_rule_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("decision_rules.id"), nullable=False
        ),
        sa.Column(
            "existing_rule_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("decision_rules.id"),
            nullable=False,
        ),
        sa.Column("relation", sa.String(), nullable=False),
        sa.Column("explanation", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="open"),
        sa.Column("resolution", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_by", sa.String(), nullable=True),
    )
    op.create_index("ix_rule_review_cases_org_id", "rule_review_cases", ["org_id"])
    op.create_index("ix_rule_review_cases_org_status", "rule_review_cases", ["org_id", "status"])


def downgrade() -> None:
    op.drop_table("rule_review_cases")
    op.execute("DROP INDEX IF EXISTS ix_decision_rules_embedding_hnsw")
    op.drop_table("decision_rules")

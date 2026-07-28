"""Drops decision_rules — the middle-generation structured-rule table.
Genuinely dead, not just superseded: nothing in the codebase reads or
writes it anymore. Its own docstring in db/models.py claimed
compiler/pack.py's compile_skill_pack still read approved rows from it,
but that stopped being true back at commit 24003e2 ("port
compile_skill_pack to git-native rules, not the frozen decision_rules
table") — the comment just never got updated. Confirmed via a repo-wide
grep: the only remaining references were the class definition itself and
that stale comment. rule_review_cases (the table this generation's
review-case mechanism used) was already dropped in migration 0012.

Revision ID: 0018
Revises: 0017
Create Date: 2026-07-17
"""

import pgvector.sqlalchemy
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None

_DIM = 1024


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_decision_rules_embedding_hnsw")
    op.drop_table("decision_rules")


def downgrade() -> None:
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

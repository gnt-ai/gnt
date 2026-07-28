"""pgvector extension, knowledge_units.embedding + HNSW index, conflicts, interview_questions

Revision ID: 0002
Revises: 0001
Create Date: 2026-07-09
"""

import pgvector.sqlalchemy
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

_DIM = 1024


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.add_column(
        "knowledge_units", sa.Column("embedding", pgvector.sqlalchemy.Vector(_DIM), nullable=True)
    )
    op.execute(
        "CREATE INDEX ix_knowledge_units_embedding_hnsw ON knowledge_units "
        "USING hnsw (embedding vector_cosine_ops)"
    )

    op.create_table(
        "conflicts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("unit_a_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("knowledge_units.id"), nullable=False),
        sa.Column("unit_b_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("knowledge_units.id"), nullable=False),
        sa.Column("explanation", sa.String(), nullable=False),
        sa.Column("assigned_contributor_hash", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False, server_default="open"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_conflicts_org_id", "conflicts", ["org_id"])

    op.create_table(
        "interview_questions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("topic", sa.String(), nullable=True),
        sa.Column("question", sa.String(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="open"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("answered_at", sa.DateTime(), nullable=True),
        sa.Column(
            "answer_event_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ingest_events.id"),
            nullable=True,
        ),
    )
    op.create_index("ix_interview_questions_org_id", "interview_questions", ["org_id"])


def downgrade() -> None:
    op.drop_table("interview_questions")
    op.drop_table("conflicts")
    op.execute("DROP INDEX IF EXISTS ix_knowledge_units_embedding_hnsw")
    op.drop_column("knowledge_units", "embedding")
    op.execute("DROP EXTENSION IF EXISTS vector")

"""Execution plan Phase 2 — the fields the MCP serving layer needs that
Phase 1 didn't add: real key management (name, revocation — mcp_api_keys
had neither, and last_used_at existed but was never actually written to)
and semantic search over rules (embedding + tags, mirroring the existing
knowledge_units.embedding pattern).

Revision ID: 0009
Revises: 0008
Create Date: 2026-07-13
"""

import pgvector.sqlalchemy
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

_EMBEDDING_DIM = 1024


def upgrade() -> None:
    op.add_column("mcp_api_keys", sa.Column("name", sa.String(), nullable=True))
    op.add_column(
        "mcp_api_keys", sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True)
    )

    op.add_column(
        "rules",
        sa.Column("embedding", pgvector.sqlalchemy.Vector(_EMBEDDING_DIM), nullable=True),
    )
    op.add_column(
        "rules",
        sa.Column("tags", postgresql.JSONB(), nullable=False, server_default="[]"),
    )
    op.execute(
        "CREATE INDEX ix_rules_embedding ON rules USING hnsw (embedding vector_cosine_ops)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX ix_rules_embedding")
    op.drop_column("rules", "tags")
    op.drop_column("rules", "embedding")
    op.drop_column("mcp_api_keys", "revoked_at")
    op.drop_column("mcp_api_keys", "name")

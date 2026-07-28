"""convert all timestamp columns to TIMESTAMPTZ — app code writes tz-aware
datetimes (datetime.now(timezone.utc)) and asyncpg rejects binding those
into a naive TIMESTAMP column

Revision ID: 0003
Revises: 0002
Create Date: 2026-07-09
"""

import sqlalchemy as sa

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

_COLUMNS = [
    ("orgs", "created_at"),
    ("mcp_api_keys", "created_at"),
    ("mcp_api_keys", "last_used_at"),
    ("ingest_events", "created_at"),
    ("ingest_events", "processed_at"),
    ("knowledge_units", "created_at"),
    ("conflicts", "created_at"),
    ("conflicts", "resolved_at"),
    ("interview_questions", "created_at"),
    ("interview_questions", "answered_at"),
    ("skill_packs", "created_at"),
]


def upgrade() -> None:
    for table, column in _COLUMNS:
        op.alter_column(
            table,
            column,
            type_=sa.DateTime(timezone=True),
            postgresql_using=f"{column} AT TIME ZONE 'UTC'",
        )


def downgrade() -> None:
    for table, column in _COLUMNS:
        op.alter_column(
            table,
            column,
            type_=sa.DateTime(timezone=False),
            postgresql_using=f"{column} AT TIME ZONE 'UTC'",
        )

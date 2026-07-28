"""slack_connections — one active Slack workspace connection per org. org_id
and team_id are both unique: org_id so a reinstall upserts, team_id so a
workspace can never be connected to two orgs at once (the slash-command
handler trusts this as its only tenant lookup).

Revision ID: 0005
Revises: 0004
Create Date: 2026-07-11
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "slack_connections",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False, unique=True),
        sa.Column("team_id", sa.String(), nullable=False, unique=True),
        sa.Column("team_name", sa.String(), nullable=False),
        sa.Column("bot_user_id", sa.String(), nullable=False),
        sa.Column("bot_token_encrypted", sa.String(), nullable=False),
        sa.Column("scope", sa.String(), nullable=False),
        sa.Column("installed_by_user_id", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_slack_connections_org_id", "slack_connections", ["org_id"])
    op.create_index("ix_slack_connections_team_id", "slack_connections", ["team_id"])


def downgrade() -> None:
    op.drop_table("slack_connections")

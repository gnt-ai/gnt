"""Adds github_connections — one connected rules repo per org, for the
git-native rules storage rewrite (see docs/migration/RECONCILE_V2.md and
docs/migration/GIT_NATIVE_SPIKE.md). Mirrors slack_connections' shape
(org_id unique, encrypted secrets, installed_by_user_id) but as its own
dedicated table, not a shared polymorphic Connector.

Revision ID: 0011
Revises: 0010
Create Date: 2026-07-14
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "github_connections",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False, unique=True),
        sa.Column("repo_url", sa.String(), nullable=False, unique=True),
        sa.Column("default_branch", sa.String(), nullable=False, server_default="main"),
        sa.Column("pat_encrypted", sa.String(), nullable=False),
        sa.Column("webhook_secret_encrypted", sa.String(), nullable=False),
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
    op.create_index("ix_github_connections_org_id", "github_connections", ["org_id"])
    op.create_index("ix_github_connections_repo_url", "github_connections", ["repo_url"])


def downgrade() -> None:
    op.drop_index("ix_github_connections_repo_url", table_name="github_connections")
    op.drop_index("ix_github_connections_org_id", table_name="github_connections")
    op.drop_table("github_connections")

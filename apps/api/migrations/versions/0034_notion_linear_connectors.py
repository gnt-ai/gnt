"""Notion and Linear connectors (OAuth sprint T14 dashboard track) — a new
credential-acquisition path alongside the CLI-local flows already shipped
in apps/cli. apps/api holds an encrypted OAuth token per org (this
migration); the CLI fetches its own org's token back over an authenticated
call (GET /v1/<vendor>/token, api-key or JWT, either way scoped by
get_current_org) and does the actual read/parse/chunk/privacy-gate work
locally, exactly as it already does for a pasted or CLI-acquired token —
nothing about the read path changes, only how the credential reaches the
CLI (typed/pasted before, one click in the dashboard now).

Both tables are RLS-eligible, same reasoning 0030_intercom_connector.py
gives for intercom_connections over slack_connections/github_connections:
no inbound webhook needs to look either table up by an external id before
an org_id is known, every read here is already inside an org-scoped
session, so the standard tenant_isolation policy applies.

notion_connections carries workspace_id/workspace_name/bot_id (Notion's
own OAuth token response includes all three) purely for a friendlier
"Connected to <workspace>" status line -- unused by the credential-relay
path itself. linear_connections has no equivalent identity field: Linear's
token response carries no workspace/user info without an extra API call
this task doesn't make, so its status line is just "Connected" (see
routers/linear.py).

Revision ID: 0034
Revises: 0033
Create Date: 2026-07-25
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0034"
down_revision = "0033"
branch_labels = None
depends_on = None

_RLS_TABLES = ("notion_connections", "linear_connections")


def upgrade() -> None:
    op.create_table(
        "notion_connections",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False, unique=True),
        sa.Column("access_token_encrypted", sa.String(), nullable=False),
        sa.Column("workspace_id", sa.String(), nullable=True),
        sa.Column("workspace_name", sa.String(), nullable=True),
        sa.Column("bot_id", sa.String(), nullable=True),
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
    op.create_index("ix_notion_connections_org_id", "notion_connections", ["org_id"])

    op.create_table(
        "linear_connections",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False, unique=True),
        sa.Column("access_token_encrypted", sa.String(), nullable=False),
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
    op.create_index("ix_linear_connections_org_id", "linear_connections", ["org_id"])

    for table in _RLS_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY tenant_isolation ON {table} "
            "USING (org_id = current_setting('app.current_org', true)) "
            "WITH CHECK (org_id = current_setting('app.current_org', true))"
        )


def downgrade() -> None:
    for table in reversed(_RLS_TABLES):
        op.execute(f"DROP POLICY tenant_isolation ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")

    op.drop_table("linear_connections")
    op.drop_table("notion_connections")

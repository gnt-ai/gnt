"""CLI keys and MCP keys have always shared mcp_api_keys with no column
telling them apart -- only a soft convention (create_cli_key defaults
name to "cli", nothing enforces or reads it back). CLI keys currently
can't be revoked server-side at all -- `gnt logout` only ever deleted the
local credentials file -- and a security kill switch needs a CLI-specific
list/revoke surface, so this adds an explicit key_type column and backfills
existing rows using that same naming convention, the only signal
available for anything minted before this column existed.

Revision ID: 0017
Revises: 0016
Create Date: 2026-07-16
"""

import sqlalchemy as sa

from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "mcp_api_keys",
        sa.Column("key_type", sa.String(), nullable=False, server_default="mcp"),
    )
    op.execute("UPDATE mcp_api_keys SET key_type = 'cli' WHERE name = 'cli'")


def downgrade() -> None:
    op.drop_column("mcp_api_keys", "key_type")

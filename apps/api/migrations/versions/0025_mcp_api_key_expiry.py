"""Key expiry and rotation. Adds expires_at to
mcp_api_keys, shared by both key_type values (cli and mcp) since they've
always lived in this one table (migration 0017's docstring). Nullable, no
backfill: every row that exists before this migration lands keeps
expires_at = NULL, meaning "never expires" -- this migration does not
retroactively expire anyone. Only create_cli_key (routers/settings.py)
sets a default (90 days) on new rows going forward; create_mcp_key leaves
it null. See gnt.db.models.McpApiKey's expires_at comment for the full
reasoning.

Revision ID: 0025
Revises: 0024
Create Date: 2026-07-18
"""

import sqlalchemy as sa

from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "mcp_api_keys",
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("mcp_api_keys", "expires_at")

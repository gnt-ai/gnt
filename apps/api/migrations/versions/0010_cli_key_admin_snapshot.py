"""gnt review needs a CLI credential that can call the admin-gated rule
approve/reject endpoints — the existing mcp_api_keys are deliberately never
admin-capable (a service/MCP-serving key must never self-approve a rule).
This adds an is_admin snapshot column so a NEW, separate minting path
(POST /v1/settings/cli-key, gated on a real Clerk session, not another API
key) can capture the signed-in user's admin status onto their own personal
CLI key. The existing /v1/settings/mcp-keys path is untouched and always
mints is_admin=False.

Revision ID: 0010
Revises: 0009
Create Date: 2026-07-14
"""

import sqlalchemy as sa

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "mcp_api_keys",
        sa.Column("is_admin", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("mcp_api_keys", "is_admin")

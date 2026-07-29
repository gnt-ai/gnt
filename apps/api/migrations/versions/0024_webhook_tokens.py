"""webhook_tokens — backs generic webhook ingestion. See
gnt.db.models.WebhookToken for the full reasoning and gnt.routers.webhooks
for the one endpoint this authenticates (draft-rule ingest only).

No RLS, deliberately — same reasoning as migration 0001's mcp_api_keys:
this table is looked up to RESOLVE an org from an opaque token, which has
to happen before app.current_org is set, so RLS (which depends on that
GUC already being set) can't apply here.

Revision ID: 0024
Revises: 0023
Create Date: 2026-07-18
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "webhook_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("token_hash", sa.String(), nullable=False, unique=True),
        sa.Column("name", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_webhook_tokens_org_id", "webhook_tokens", ["org_id"])


def downgrade() -> None:
    op.drop_table("webhook_tokens")

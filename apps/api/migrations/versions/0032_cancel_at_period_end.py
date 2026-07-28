"""Billing — cancel_at_period_end and current_period_end on orgs. Backs
the in-app cancel flow (gnt/billing.py's cancel_subscription) so the
settings page can show "canceling, access continues until <date>" without
a portal round-trip, and without a live Stripe call on every status
check -- current_period_end is stamped straight from the same webhook
events that already sync cancel_at_period_end, so a page reload shows the
same real date the cancel action itself returned. Kept in sync from
Stripe's own subscription.updated/deleted events too (apply_webhook_event),
so both stay correct even if a subscription is canceled from the Stripe
dashboard directly. cancel_at_period_end not null, defaults false -- every
existing org's subscription is not pending cancellation.

Revision ID: 0032
Revises: 0031
Create Date: 2026-07-21
"""

import sqlalchemy as sa

from alembic import op

revision = "0032"
down_revision = "0031"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "orgs",
        sa.Column("cancel_at_period_end", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.add_column("orgs", sa.Column("current_period_end", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("orgs", "current_period_end")
    op.drop_column("orgs", "cancel_at_period_end")

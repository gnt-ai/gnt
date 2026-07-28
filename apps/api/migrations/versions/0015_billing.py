"""Billing — trial + subscription state on orgs. Single flat tier, no
metering (see the pricing decision this followed). trial_ends_at is a
purely local gate that needs no Stripe involvement during the trial;
stripe_customer_id/stripe_subscription_id/subscription_status stay null
until an org actually goes through Checkout once, at which point webhooks
keep subscription_status in sync.

Revision ID: 0015
Revises: 0014
Create Date: 2026-07-16
"""

import sqlalchemy as sa

from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "orgs",
        sa.Column(
            "trial_ends_at",
            sa.DateTime(timezone=True),
            nullable=False,
            # Existing orgs (created before this migration) get a trial
            # window starting now, same as a brand-new org would — not
            # backdated to their original created_at, which would leave
            # every pre-existing org's trial already expired. This default
            # only exists to backfill those rows in this one ALTER TABLE —
            # dropped immediately after so it can never silently diverge
            # from BILLING_TRIAL_DAYS for a future row; ensure_org (db/org.py)
            # always supplies trial_ends_at explicitly on insert.
            server_default=sa.text("now() + interval '14 days'"),
        ),
    )
    op.alter_column("orgs", "trial_ends_at", server_default=None)
    op.add_column("orgs", sa.Column("stripe_customer_id", sa.String(), nullable=True, unique=True))
    op.add_column("orgs", sa.Column("stripe_subscription_id", sa.String(), nullable=True, unique=True))
    op.add_column("orgs", sa.Column("subscription_status", sa.String(), nullable=True))
    op.add_column(
        "orgs", sa.Column("subscription_status_synced_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("orgs", "subscription_status_synced_at")
    op.drop_column("orgs", "subscription_status")
    op.drop_column("orgs", "stripe_subscription_id")
    op.drop_column("orgs", "stripe_customer_id")
    op.drop_column("orgs", "trial_ends_at")

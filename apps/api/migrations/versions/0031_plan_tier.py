"""Billing — plan_tier on orgs ("base" or "pro"). Second Stripe price
(the $149/mo pro tier, 8000 check_action calls/month vs base's 1500 — see
gnt/plan_limits.py) is also the only tier that allows multi-org
membership (apps/web/lib/auth.ts's beforeCreateInvitation). Nullable, no
default: an org that hasn't gone through Checkout yet has no tier
opinion — plan_limits.py's cap_for_tier already treats null the same as
base, so there's nothing to backfill existing rows with.

Revision ID: 0031
Revises: 0030
Create Date: 2026-07-20
"""

import sqlalchemy as sa

from alembic import op

revision = "0031"
down_revision = "0030"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("orgs", sa.Column("plan_tier", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("orgs", "plan_tier")

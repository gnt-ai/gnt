"""knowledge_units decay fields — decay_lambda (per-type default, overridable
per row) and freshness_at (reference point for the nightly decay job, reset
whenever a unit is reconfirmed).

Revision ID: 0006
Revises: 0005
Create Date: 2026-07-13
"""

import sqlalchemy as sa

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "knowledge_units",
        sa.Column("decay_lambda", sa.Float(), server_default="0.01", nullable=False),
    )
    op.add_column(
        "knowledge_units",
        sa.Column(
            "freshness_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("knowledge_units", "freshness_at")
    op.drop_column("knowledge_units", "decay_lambda")

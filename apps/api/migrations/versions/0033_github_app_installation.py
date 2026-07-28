"""GitHub App connect flow — adds installation_id to github_connections
and relaxes pat_encrypted/webhook_secret_encrypted to nullable, since an
App-connected row has neither (its tokens are minted per-operation, never
persisted — see gnt/github/app_auth.py). installation_id is NULL for a
PAT-connected row, unique + indexed when set (see the model's own
docstring for why one column doubles as the discriminator between the two
connect flows instead of a parallel table).

Revision ID: 0033
Revises: 0032
Create Date: 2026-07-22
"""

import sqlalchemy as sa

from alembic import op

revision = "0033"
down_revision = "0032"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("github_connections", sa.Column("installation_id", sa.BigInteger(), nullable=True))
    op.create_index(
        "ix_github_connections_installation_id",
        "github_connections",
        ["installation_id"],
        unique=True,
    )
    op.alter_column("github_connections", "pat_encrypted", existing_type=sa.String(), nullable=True)
    op.alter_column("github_connections", "webhook_secret_encrypted", existing_type=sa.String(), nullable=True)


def downgrade() -> None:
    op.alter_column("github_connections", "webhook_secret_encrypted", existing_type=sa.String(), nullable=False)
    op.alter_column("github_connections", "pat_encrypted", existing_type=sa.String(), nullable=False)
    op.drop_index("ix_github_connections_installation_id", table_name="github_connections")
    op.drop_column("github_connections", "installation_id")

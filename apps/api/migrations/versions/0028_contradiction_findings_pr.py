"""contradiction_findings.pr_number / pr_url — tracks proposed-resolution
PRs. The nightly contradiction sweep now opens a real PR
amending one of the two contradicting rules to defer to the other,
alongside the GitHub issue it already filed (see workers/
tasks_contradictions.py). Both nullable: the issue is always filed before a
PR is even attempted, so a row can legitimately record the issue with no
PR — opening the PR is best-effort, and its own failure must never look
like "this pair was never filed" and re-trigger a duplicate issue on a
rerun.

Revision ID: 0028
Revises: 0027
Create Date: 2026-07-18
"""

import sqlalchemy as sa

from alembic import op

revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("contradiction_findings", sa.Column("pr_number", sa.Integer(), nullable=True))
    op.add_column("contradiction_findings", sa.Column("pr_url", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("contradiction_findings", "pr_url")
    op.drop_column("contradiction_findings", "pr_number")

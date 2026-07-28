"""Drops rule_review_cases — the old decision_rules pipeline's blocking
review-case mechanism, superseded by propose_rule's soft conflict-check
(pipeline/rule_conflict.py, see docs/migration/GIT_NATIVE_DONE.md). Only
this table goes: decision_rules itself stays, since compiler/pack.py's
compile_skill_pack still reads approved rows from it into every org's
skill pack — nothing writes new rows to it anymore (the ingest/approve
router that used to is gone), but existing rows must keep rendering.

Revision ID: 0012
Revises: 0011
Create Date: 2026-07-14
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("rule_review_cases")


def downgrade() -> None:
    op.create_table(
        "rule_review_cases",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column(
            "new_rule_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("decision_rules.id"), nullable=False
        ),
        sa.Column(
            "existing_rule_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("decision_rules.id"),
            nullable=False,
        ),
        sa.Column("relation", sa.String(), nullable=False),
        sa.Column("explanation", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="open"),
        sa.Column("resolution", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_by", sa.String(), nullable=True),
    )
    op.create_index("ix_rule_review_cases_org_id", "rule_review_cases", ["org_id"])
    op.create_index("ix_rule_review_cases_org_status", "rule_review_cases", ["org_id", "status"])

"""initial schema — orgs, mcp_api_keys, ingest_events, knowledge_units, skill_packs, skill_files

Revision ID: 0001
Revises:
Create Date: 2026-07-09
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "orgs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "mcp_api_keys",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("key_hash", sa.String(), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_mcp_api_keys_org_id", "mcp_api_keys", ["org_id"])

    op.create_table(
        "ingest_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("provenance", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("contributor_hash", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("processed_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_ingest_events_org_id", "ingest_events", ["org_id"])

    op.create_table(
        "knowledge_units",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("topic", sa.String(), nullable=False),
        sa.Column("statement", sa.String(), nullable=False),
        sa.Column("details", sa.String(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0.7"),
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
        sa.Column(
            "source_event_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ingest_events.id"),
            nullable=False,
        ),
        sa.Column("contributor_hash", sa.String(), nullable=False),
        sa.Column(
            "superseded_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("knowledge_units.id"), nullable=True
        ),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_knowledge_units_org_id", "knowledge_units", ["org_id"])
    op.create_index("ix_knowledge_units_topic", "knowledge_units", ["topic"])
    op.create_index("ix_knowledge_units_org_status", "knowledge_units", ["org_id", "status"])

    op.create_table(
        "skill_packs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("orgs.id"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("manifest", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("org_id", "version", name="uq_skill_pack_org_version"),
    )
    op.create_index("ix_skill_packs_org_id", "skill_packs", ["org_id"])

    op.create_table(
        "skill_files",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("pack_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("skill_packs.id"), nullable=False),
        sa.Column("path", sa.String(), nullable=False),
        sa.Column("content", sa.String(), nullable=False),
        sa.Column("sha256", sa.String(), nullable=False),
    )
    op.create_index("ix_skill_files_pack_id", "skill_files", ["pack_id"])


def downgrade() -> None:
    op.drop_table("skill_files")
    op.drop_table("skill_packs")
    op.drop_table("knowledge_units")
    op.drop_table("ingest_events")
    op.drop_table("mcp_api_keys")
    op.drop_table("orgs")

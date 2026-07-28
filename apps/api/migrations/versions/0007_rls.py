"""Row-level security, keyed on the app.current_org GUC that
gnt.db.rls.scope_to_org sets once per request/task (defense-in-depth per
the plan — application code already filters every query by org_id
explicitly, this is a second, independent backstop enforced by Postgres
itself, so a future endpoint that forgets an org_id filter fails closed
instead of leaking rows).

FORCE (not just ENABLE) row level security, since this app connects as a
single role that also owns the tables — plain ENABLE only restricts
non-owner roles, table owners bypass RLS by default.

Two tables are deliberately NOT included:
- mcp_api_keys: auth/api_key.py's resolve_api_key and
  mcp_server/auth.py's McpAuthMiddleware both have to look a key up by
  key_hash *before* they know which org it belongs to — that lookup
  can't be org-scoped by definition. The key hash itself (sha256 of a
  32-byte random token) is the real access control here.
- slack_connections: routers/slack.py's slash-command handler has the
  identical bootstrapping problem, looking a workspace up by team_id
  before it knows the org. Slack's own request signature is what
  authenticates that path instead of our org auth.

Revision ID: 0007
Revises: 0006
Create Date: 2026-07-13
"""

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

_ORG_ID_TABLES = [
    "orgs",
    "ingest_events",
    "knowledge_units",
    "conflicts",
    "interview_questions",
    "skill_packs",
    "decision_rules",
    "rule_review_cases",
]


def upgrade() -> None:
    for table in _ORG_ID_TABLES:
        org_column = "id" if table == "orgs" else "org_id"
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY tenant_isolation ON {table} "
            f"USING ({org_column} = current_setting('app.current_org', true)) "
            f"WITH CHECK ({org_column} = current_setting('app.current_org', true))"
        )

    # skill_files has no org_id of its own — scoped through its parent pack.
    op.execute("ALTER TABLE skill_files ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE skill_files FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON skill_files "
        "USING (pack_id IN (SELECT id FROM skill_packs WHERE org_id = current_setting('app.current_org', true))) "
        "WITH CHECK (pack_id IN (SELECT id FROM skill_packs WHERE org_id = current_setting('app.current_org', true)))"
    )


def downgrade() -> None:
    op.execute("DROP POLICY tenant_isolation ON skill_files")
    op.execute("ALTER TABLE skill_files NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE skill_files DISABLE ROW LEVEL SECURITY")

    for table in reversed(_ORG_ID_TABLES):
        op.execute(f"DROP POLICY tenant_isolation ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")

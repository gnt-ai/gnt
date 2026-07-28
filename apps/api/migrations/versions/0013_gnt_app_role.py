"""Creates gnt_app — the non-superuser role the application should
actually connect as, so 0007's FORCE ROW LEVEL SECURITY policies enforce
for real.

FORCE ROW LEVEL SECURITY only closes the "table owner bypasses RLS"
gap — a genuine Postgres superuser bypasses RLS regardless of FORCE, no
exception. Every environment (local dev, tests, and until this migration
deploys, production) has been connecting as a superuser, which means RLS
has been pure theater: enforced in the DDL, bypassed at the connection
level.

gnt_app gets LOGIN and DML grants only — no CREATEDB, no CREATEROLE, no
SUPERUSER, no BYPASSRLS. It does not own any table (ownership stays with
whatever role runs migrations), which is required for FORCE ROW LEVEL
SECURITY to actually apply to it.

The role's password is set out of band, per environment, via
`ALTER ROLE gnt_app WITH PASSWORD '...'` run manually — never in a
migration file, which is checked into git and applies identically
everywhere.

Revision ID: 0013
Revises: 0012
Create Date: 2026-07-15
"""

from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'gnt_app') THEN
            CREATE ROLE gnt_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
          END IF;
        END
        $$;
        """
    )
    # current_database() can't be used directly, GRANT doesn't accept a
    # function call as the object name, so this dynamic-SQL indirection is
    # needed to keep the migration portable across local/test/prod DB names.
    op.execute(
        """
        DO $$
        BEGIN
          EXECUTE format('GRANT CONNECT ON DATABASE %I TO gnt_app', current_database());
        END
        $$;
        """
    )
    op.execute("GRANT USAGE ON SCHEMA public TO gnt_app")
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gnt_app")
    # alembic_version is Alembic's own migration-bookkeeping table, not
    # application data — the blanket grant above includes it since it's
    # just another table in the schema, but gnt_app (a request-scoped
    # runtime role) has no legitimate reason to read or write it.
    op.execute("REVOKE ALL PRIVILEGES ON TABLE public.alembic_version FROM gnt_app")
    op.execute("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gnt_app")
    # No FOR ROLE clause — defaults to whichever role runs this statement,
    # i.e. whichever role runs migrations. Every future migration also runs
    # as that same role, so tables it creates later automatically grant to
    # gnt_app too, without needing to know that role's name in advance.
    op.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gnt_app")
    op.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO gnt_app")


def downgrade() -> None:
    op.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM gnt_app")
    op.execute(
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM gnt_app"
    )
    op.execute("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM gnt_app")
    op.execute("REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM gnt_app")
    op.execute("REVOKE USAGE ON SCHEMA public FROM gnt_app")
    op.execute(
        """
        DO $$
        BEGIN
          EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM gnt_app', current_database());
        END
        $$;
        """
    )
    op.execute("DROP ROLE IF EXISTS gnt_app")

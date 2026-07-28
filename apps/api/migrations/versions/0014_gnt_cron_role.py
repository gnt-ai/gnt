"""Creates gnt_cron — a second, narrow-purpose role for background
maintenance jobs that legitimately need to touch every org's data in one
statement (decay_confidence's bulk UPDATE across all of knowledge_units),
not one org's.

gnt_app (migration 0013) can't do this: RLS scopes to exactly one org per
transaction via the app.current_org GUC, and there is no way to even
enumerate "every org" under real RLS enforcement without already knowing
which org to scope to — orgs itself is RLS-protected. gnt_cron gets
BYPASSRLS specifically to close that gap, while staying NOSUPERUSER,
NOCREATEDB, NOCREATEROLE — it can read/write data across every org, but
it cannot do schema DDL, create other roles, or create databases. This
must be used only by genuinely cross-tenant maintenance code (currently:
workers/tasks_cron.py's decay_confidence), never by request-scoped
application code — that stays gnt_app's job.

Password set out of band per environment, same as gnt_app.

Revision ID: 0014
Revises: 0013
Create Date: 2026-07-15
"""

from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'gnt_cron') THEN
            CREATE ROLE gnt_cron WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
          END IF;
        END
        $$;
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
          EXECUTE format('GRANT CONNECT ON DATABASE %I TO gnt_cron', current_database());
        END
        $$;
        """
    )
    op.execute("GRANT USAGE ON SCHEMA public TO gnt_cron")
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gnt_cron")
    # Same reasoning as 0013's gnt_app revoke — Alembic's own bookkeeping
    # table, no legitimate reason for a data-maintenance job to touch it.
    op.execute("REVOKE ALL PRIVILEGES ON TABLE public.alembic_version FROM gnt_cron")
    op.execute("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gnt_cron")
    op.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gnt_cron")
    op.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO gnt_cron")


def downgrade() -> None:
    op.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM gnt_cron")
    op.execute(
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM gnt_cron"
    )
    op.execute("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM gnt_cron")
    op.execute("REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM gnt_cron")
    op.execute("REVOKE USAGE ON SCHEMA public FROM gnt_cron")
    op.execute(
        """
        DO $$
        BEGIN
          EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM gnt_cron', current_database());
        END
        $$;
        """
    )
    op.execute("DROP ROLE IF EXISTS gnt_cron")

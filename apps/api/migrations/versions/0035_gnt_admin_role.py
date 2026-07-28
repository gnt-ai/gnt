"""Creates gnt_admin — a third, narrow-purpose role for the internal
platform-admin dashboard (founder-only, cross-org visibility into every
org: plan tier, usage, spend, rules, gaps, connectors, members).

Same RLS-bypass need as gnt_cron (migration 0014): a cross-org view can't
be built under gnt_app, since RLS scopes to exactly one org per
transaction and orgs itself is RLS-protected, so there's no way to even
enumerate "every org" under real RLS enforcement. But this is human-driven
browsing, not cron maintenance code, and it doesn't need gnt_cron's broad
read/write across every table — so gnt_admin gets SELECT on everything
(for the dashboard's read views), plus exactly one narrow write: UPDATE on
orgs.plan_tier and orgs.subscription_status only, for the one explicit
support action the dashboard exposes (comping/adjusting a plan). No
INSERT, no DELETE, no UPDATE on any other table or column. Deliberately
not given gnt_cron's privilege level — this role should never be able to
touch rule content, billing history, or connector credentials, only the
one thing a human is meant to click a button for.

Password set out of band per environment, same as gnt_app and gnt_cron.

Revision ID: 0035
Revises: 0034
Create Date: 2026-07-26
"""

from alembic import op

revision = "0035"
down_revision = "0034"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'gnt_admin') THEN
            CREATE ROLE gnt_admin WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
          END IF;
        END
        $$;
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
          EXECUTE format('GRANT CONNECT ON DATABASE %I TO gnt_admin', current_database());
        END
        $$;
        """
    )
    op.execute("GRANT USAGE ON SCHEMA public TO gnt_admin")
    op.execute("GRANT SELECT ON ALL TABLES IN SCHEMA public TO gnt_admin")
    # Same reasoning as 0013/0014's alembic_version revoke — no legitimate
    # reason for a dashboard read/comp role to see Alembic's own bookkeeping.
    op.execute("REVOKE ALL PRIVILEGES ON TABLE public.alembic_version FROM gnt_admin")
    # The one write this role gets: comping/adjusting a plan tier. Column-
    # scoped on purpose — everything else on orgs (Stripe ids, timestamps)
    # stays read-only even to this role.
    op.execute("GRANT UPDATE (plan_tier, subscription_status) ON public.orgs TO gnt_admin")
    op.execute("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gnt_admin")
    op.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO gnt_admin")
    op.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO gnt_admin")


def downgrade() -> None:
    op.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM gnt_admin")
    op.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM gnt_admin")
    op.execute("REVOKE UPDATE (plan_tier, subscription_status) ON public.orgs FROM gnt_admin")
    op.execute("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM gnt_admin")
    op.execute("REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM gnt_admin")
    op.execute("REVOKE USAGE ON SCHEMA public FROM gnt_admin")
    op.execute(
        """
        DO $$
        BEGIN
          EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM gnt_admin', current_database());
        END
        $$;
        """
    )
    op.execute("DROP ROLE IF EXISTS gnt_admin")

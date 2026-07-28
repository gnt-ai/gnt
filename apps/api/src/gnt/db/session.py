from collections.abc import AsyncIterator
from functools import lru_cache

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from gnt.config import get_settings


@lru_cache
def get_engine():
    return create_async_engine(get_settings().database_url, pool_pre_ping=True)


@lru_cache
def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_engine(), expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with get_sessionmaker()() as session:
        yield session


async def get_cron_session() -> AsyncIterator[AsyncSession]:
    """FastAPI-dependency-shaped wrapper around get_cron_sessionmaker(),
    for the handful of request paths that are legitimately cross-org
    lookups authenticated by something other than an org-scoped session —
    today: routers/billing.py's Stripe webhook, which has to resolve an
    org from a stripe_subscription_id it doesn't have an org_id for yet.
    Same "look it up before you know which org" bootstrapping problem
    migration 0007 already exempts mcp_api_keys and slack_connections
    from RLS for — orgs itself stays RLS-protected for every ordinary
    org-scoped caller, this is specifically for the callers that can't
    scope_to_org() first because discovering the org IS the query."""
    async with get_cron_sessionmaker()() as session:
        yield session


@lru_cache
def get_cron_engine():
    """gnt_cron (migration 0014) — BYPASSRLS, for genuinely cross-org or
    pre-org-resolution work only (currently: get_cron_session above, for
    routers/billing.py's Stripe webhook). Never use this for
    request-scoped or per-org application code — that's
    get_sessionmaker()'s job.

    Deliberately no fallback to database_url: unlike migration_database_url
    (where DDL against gnt_app fails loudly with a permission error),
    falling back here would mean a bulk/unscoped write quietly matches
    zero rows under gnt_app's RLS — a working-looking no-op, not an error.
    Better to fail at startup than silently stop working."""
    settings = get_settings()
    if not settings.cron_database_url:
        raise RuntimeError(
            "CRON_DATABASE_URL is required for gnt_cron-backed work (e.g. the billing "
            "webhook) to run — falling back to DATABASE_URL (gnt_app) would silently "
            "no-op under RLS instead"
        )
    return create_async_engine(settings.cron_database_url, pool_pre_ping=True)


@lru_cache
def get_cron_sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_cron_engine(), expire_on_commit=False)


async def get_admin_session() -> AsyncIterator[AsyncSession]:
    """FastAPI-dependency-shaped wrapper around get_admin_sessionmaker(),
    for the internal platform-admin dashboard's routes (routers/
    platform_admin.py) — the one caller that's legitimately reading (and,
    for plan_tier/subscription_status specifically, writing) across every
    org rather than one RLS-scoped org."""
    async with get_admin_sessionmaker()() as session:
        yield session


@lru_cache
def get_admin_engine():
    """gnt_admin (migration 0035) — BYPASSRLS, SELECT on everything plus a
    column-scoped UPDATE on orgs.plan_tier/subscription_status only. Never
    use this for request-scoped or per-org application code — that's
    get_sessionmaker()'s job — and never use it for a write beyond the one
    the role is actually granted; the DB itself enforces that, but this
    engine should never be reached for anything else in the first place.

    Deliberately no fallback to database_url, same reasoning as
    get_cron_engine: falling back would mean an admin-dashboard read
    quietly returns only gnt_app's own RLS-scoped view (one org, not
    every org) instead of erroring — a working-looking wrong answer, not
    a loud failure."""
    settings = get_settings()
    if not settings.admin_database_url:
        raise RuntimeError(
            "ADMIN_DATABASE_URL is required for gnt_admin-backed work (the platform-admin "
            "dashboard) to run — falling back to DATABASE_URL (gnt_app) would silently "
            "scope to one org instead of every org"
        )
    return create_async_engine(settings.admin_database_url, pool_pre_ping=True)


@lru_cache
def get_admin_sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_admin_engine(), expire_on_commit=False)

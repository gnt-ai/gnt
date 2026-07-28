"""Async API tests against a real Postgres test DB — a dedicated database
(same server as local dev, name suffixed _test), migrated once per test
session via a real `alembic upgrade head` subprocess (exactly the command
that runs in CI/deploy, not a re-implementation of it), then each test
runs inside its own transaction that's rolled back afterward so tests
never see each other's writes and never need to re-migrate.
"""

import asyncio
import os
import subprocess
import threading
import time
from collections import deque
from collections.abc import AsyncIterator
from urllib.parse import unquote, urlsplit, urlunsplit

import asyncpg
import httpx
import pytest
import pytest_asyncio
from dotenv import dotenv_values
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from gnt.config import get_settings

# Must run before the first get_settings() call in this file (including
# _test_database_url() below, and gnt.main's module-level sentry_sdk.init
# once a test module imports it) — get_settings() is @lru_cache'd, so
# whatever SENTRY_DSN resolves to on first call sticks for the whole
# session. Empty string is Sentry's own documented way to disable the SDK
# (same effect as dsn=None) — the real DSN lives only in apps/api/.env for
# local dev/production; tests must never silently report to that live
# project (Global Rule 6).
os.environ["SENTRY_DSN"] = ""


def _suffix_test_db(url: str) -> str:
    parts = urlsplit(url)
    db_name = parts.path.lstrip("/")
    return urlunsplit((parts.scheme, parts.netloc, f"/{db_name}_test", parts.query, parts.fragment))


def _read_dotenv_value(key: str) -> str | None:
    """Reads a single value directly out of apps/api/.env, bypassing
    pydantic-settings entirely — needed only for CRON_DATABASE_URL, which
    (like SENTRY_DSN above) must be overridden to its test-suffixed form
    in os.environ before the first get_settings() call of the session,
    since get_settings() is @lru_cache'd and gnt_cron code reads
    cron_database_url indirectly through it (get_cron_sessionmaker), not
    as an explicit string like TEST_DATABASE_URL below. Uses python-dotenv
    (already a pydantic-settings dependency) rather than a manual line
    parse, so quoting/escaping match what Settings' own env_file loading
    would see."""
    env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
    if not os.path.exists(env_path):
        return None
    return dotenv_values(env_path).get(key)


# Unconditionally re-suffix whatever's configured, regardless of whether
# it came from a real env var (CI sets one directly, pointing at the base
# db) or apps/api/.env (local dev) — checking "already in os.environ"
# first would wrongly assume a real env var is already test-suffixed,
# which breaks exactly the CI case this exists for.
_raw_cron_url = os.environ.get("CRON_DATABASE_URL") or _read_dotenv_value("CRON_DATABASE_URL")
if _raw_cron_url:
    os.environ["CRON_DATABASE_URL"] = _suffix_test_db(_raw_cron_url)

@pytest_asyncio.fixture(autouse=True)
async def _redis_pool() -> AsyncIterator[None]:
    """The sliding-window rate limiter is real Redis, not mocked — Redis
    itself isn't a paid/external API like Voyage or Anthropic, it's local
    dev infrastructure this repo already depends on, so there's nothing
    to fake here (also needed in CI — see the redis service in ci.yml).

    Function-scoped, not session-scoped: pytest-asyncio gives each test
    function its own event loop by default, and a session-scoped async
    resource (this pool, or the engines tests/conftest.py's db_session
    creates) ends up bound to whichever loop was active when it was
    created — reused across tests on a DIFFERENT loop, that surfaces as
    "attached to a different loop" / "Event loop is closed". One extra
    Redis connect/disconnect per test is cheap; chasing a shared-loop
    setup to avoid it isn't worth the fragility."""
    from gnt.queue import close_pool, init_pool

    await init_pool()
    yield
    await close_pool()


def _test_database_url() -> str:
    # get_settings() goes through pydantic-settings' own .env loading —
    # DATABASE_URL usually isn't a real shell env var, it only lives in
    # apps/api/.env, so reading os.environ directly here would miss it.
    # This is the restricted gnt_app role (migration 0013) — used for the
    # actual test queries (db_session below), so RLS enforcement gets
    # tested against the same connection the real app uses, not a
    # superuser that would bypass it silently.
    return _suffix_test_db(get_settings().database_url)


def _test_migration_database_url() -> str:
    # The privileged role that can actually run DDL — gnt_app deliberately
    # can't. Falls back to database_url, same as config.py's own fallback,
    # for anyone who hasn't set up the role split yet.
    settings = get_settings()
    return _suffix_test_db(settings.migration_database_url or settings.database_url)


def _admin_database_url(test_url: str) -> str:
    """asyncpg needs a plain postgresql:// scheme (no +asyncpg) and has to
    connect to some existing database to run CREATE DATABASE against a
    different one."""
    parts = urlsplit(test_url)
    scheme = parts.scheme.replace("+asyncpg", "")
    return urlunsplit((scheme, parts.netloc, "/postgres", "", ""))


TEST_DATABASE_URL = _test_database_url()
TEST_MIGRATION_DATABASE_URL = _test_migration_database_url()
# Already suffixed — the os.environ override near the top of this file
# happens before get_settings() is ever called, so this is just reading
# the value back, not suffixing it a second time.
TEST_CRON_DATABASE_URL = os.environ.get("CRON_DATABASE_URL")


async def _sync_role_password(admin_url: str, test_url: str | None) -> None:
    """Idempotently sets a role's password to match test_url's — a no-op
    if test_url doesn't name one of our own restricted roles (gnt_app,
    gnt_cron), e.g. if the split isn't configured yet and database_url is
    still a privileged role with no separate password to sync."""
    if test_url is None:
        return
    parts = urlsplit(test_url)
    if parts.username not in ("gnt_app", "gnt_cron") or not parts.password:
        return
    admin_conn = await asyncpg.connect(_admin_database_url(admin_url))
    try:
        # urlsplit leaves the password percent-encoded — decode it first so
        # a password containing URL-reserved characters (e.g. one set
        # manually rather than via secrets.token_urlsafe) round-trips to
        # the literal value, not its percent-encoded form.
        password = unquote(parts.password)
        escaped_password = password.replace("'", "''")
        await admin_conn.execute(f"ALTER ROLE {parts.username} WITH PASSWORD '{escaped_password}'")
    finally:
        await admin_conn.close()


@pytest_asyncio.fixture(scope="session", autouse=True)
async def _store_server() -> AsyncIterator[None]:
    """Spawns the REAL apps/store HTTP server (real NativeStore, real
    Postgres/pgvector) as a subprocess for the whole test session —
    migration Phase 4's routers/rules.py talks to it over real HTTP,
    exactly like production does, not a mocked store_client.
    GNT_STORE_TEST_FAKE_EMBED=1 is the one difference from production: a
    deterministic fake embedding instead of a real paid provider (Global
    Rule 6), matching the discipline the store's own bun:test suite
    already applies.

    Session-scoped, not per-test: restarting per test would mean
    re-running NativeStore's schema bootstrap every single test. Tests
    instead use per-test-unique org ids (matching this file's existing
    org_a/org_b/make_org_client pattern) to avoid collisions in the
    shared store, the same way apps/store's own tests do.

    Needs its own DATABASE_URL — NativeStore is Postgres-only and expects
    a plain postgres:// URL (the `postgres` npm package), not apps/api's
    own postgresql+asyncpg:// one, and a dedicated database so its tables
    (sources/pages/content_chunks/...) never share a schema with apps/api's
    own. GNT_STORE_TEST_DATABASE_URL lets CI point this at the same
    Postgres container apps/api's own tests already use, on a separate
    database; falls back to the same local default apps/store's own
    native test suite uses."""
    settings = get_settings()
    store_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "store")
    store_database_url = os.environ.get(
        "GNT_STORE_TEST_DATABASE_URL", "postgres://localhost:5432/gnt_store_native_test"
    )
    env = {
        **os.environ,
        "DATABASE_URL": store_database_url,
        "GNT_STORE_TEST_FAKE_EMBED": "1",
        "GNT_STORE_INTERNAL_API_SECRET": settings.store_internal_api_secret,
        "GNT_APPROVAL_SIGNING_SECRET": settings.approval_signing_secret,
        # search() calls NativeStore's own hybrid search, which can rerank
        # the query itself through native/rerank.ts's zeroEntropyRerank
        # rather than through the fakeEmbed function GNT_STORE_TEST_FAKE_EMBED
        # wires up for writes. bun auto-loads apps/store/.env into this
        # subprocess regardless of what we pass here, so blank the key
        # explicitly — server.ts's testFakeEmbed branch already wires in
        # NativeStore's fakeRerank in this mode, this just makes sure
        # there's no live key sitting around for anything to find.
        "ZEROENTROPY_API_KEY": "",
    }
    process = subprocess.Popen(
        ["bun", "run", "src/http/server.ts"],
        cwd=store_dir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    # server.ts logs one JSON line per HTTP request (logCall) — nothing
    # here ever read process.stdout during normal operation (only in the
    # "exited early" branch below), so the pipe's OS buffer (~64KB) fills
    # after a few hundred requests and the child's write() to it blocks.
    # That hangs the ENTIRE store process, not just one request — every
    # test in the session after that point times out talking to it. A
    # background thread draining stdout continuously is what keeps the
    # pipe from ever filling; capped so an unusually chatty/long session
    # can't grow this unboundedly, since only the tail is ever useful for
    # the crash diagnostic below anyway.
    store_output: deque[str] = deque(maxlen=2000)

    def _drain_store_stdout() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            store_output.append(line)

    stdout_reader = threading.Thread(target=_drain_store_stdout, daemon=True)
    stdout_reader.start()

    health_url = f"{settings.store_api_url}/health"
    deadline = time.monotonic() + 30
    last_error: Exception | None = None
    async with httpx.AsyncClient() as client:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"apps/store server exited early:\n{''.join(store_output)}")
            try:
                response = await client.get(health_url, timeout=1)
                if response.status_code == 200:
                    break
            except httpx.HTTPError as exc:
                last_error = exc
            await asyncio.sleep(0.5)
        else:
            process.terminate()
            raise RuntimeError(f"apps/store server never became healthy: {last_error}")

    yield

    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
    stdout_reader.join(timeout=5)


@pytest_asyncio.fixture(scope="session", autouse=True)
async def _migrated_test_db() -> AsyncIterator[None]:
    # CREATE DATABASE and the migration subprocess below both need the
    # privileged role (gnt_app deliberately can't do DDL) — only the
    # actual test queries (db_session) run as gnt_app, so RLS gets
    # exercised for real against the same restricted connection the app
    # uses in production, not a superuser that would bypass it silently.
    db_name = urlsplit(TEST_MIGRATION_DATABASE_URL).path.lstrip("/")
    admin_conn = await asyncpg.connect(_admin_database_url(TEST_MIGRATION_DATABASE_URL))
    try:
        exists = await admin_conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", db_name)
        if not exists:
            await admin_conn.execute(f'CREATE DATABASE "{db_name}"')
    finally:
        await admin_conn.close()

    env = {
        **os.environ,
        "DATABASE_URL": TEST_DATABASE_URL,
        "MIGRATION_DATABASE_URL": TEST_MIGRATION_DATABASE_URL,
    }
    try:
        result = subprocess.run(
            ["uv", "run", "alembic", "upgrade", "head"],
            cwd=os.path.dirname(os.path.dirname(__file__)),
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("test DB migration timed out after 120s") from exc
    if result.returncode != 0:
        raise RuntimeError(f"test DB migration failed:\n{result.stdout}\n{result.stderr}")

    # Migrations create gnt_app/gnt_cron but deliberately never set a
    # password (see migration 0013's docstring — that's out-of-band, per
    # environment). Locally that's a one-time manual step; in CI the
    # Postgres container is fresh every run, so without this, CI's
    # DATABASE_URL/CRON_DATABASE_URL would need a password that doesn't
    # exist yet and every test would fail to connect. Syncing the
    # password here — to whatever's already configured in the test URLs —
    # makes both cases work the same way: a no-op locally (already
    # matches), self-provisioning in CI.
    for test_url in (TEST_DATABASE_URL, TEST_CRON_DATABASE_URL):
        await _sync_role_password(TEST_MIGRATION_DATABASE_URL, test_url)

    yield


@pytest_asyncio.fixture
async def db_session(monkeypatch) -> AsyncIterator[AsyncSession]:
    """One transaction per test, rolled back after — real Postgres, real
    RLS policies, real constraints, but no test ever sees another test's
    data and nothing needs truncating between runs.

    Also patches gnt.mcp_server.server's, gnt.mcp_server.auth's,
    gnt.llm_quota's, and gnt.plan_limits's get_sessionmaker so MCP tool
    functions, McpAuthMiddleware, the C9a LLM spend quota gate, and the
    plan's monthly check_action cap (all four open their own session
    directly, not through a FastAPI dependency override) participate in
    this same transaction — otherwise they'd open a genuinely separate
    connection that can't see this fixture's uncommitted-at-the-real-DB-
    level seed data."""
    engine = create_async_engine(TEST_DATABASE_URL)
    connection = await engine.connect()
    transaction = await connection.begin()
    session_factory = async_sessionmaker(bind=connection, expire_on_commit=False, join_transaction_mode="create_savepoint")
    monkeypatch.setattr("gnt.mcp_server.server.get_sessionmaker", lambda: session_factory)
    monkeypatch.setattr("gnt.mcp_server.auth.get_sessionmaker", lambda: session_factory)
    monkeypatch.setattr("gnt.llm_quota.get_sessionmaker", lambda: session_factory)
    monkeypatch.setattr("gnt.plan_limits.get_sessionmaker", lambda: session_factory)
    session = session_factory()
    try:
        yield session
    finally:
        await session.close()
        await transaction.rollback()
        await connection.close()
        await engine.dispose()


@pytest.fixture
def test_app_factory(db_session: AsyncSession):
    """Returns a function that builds a FRESH app instance per call. Each
    org-authenticated test client needs its own app so its
    dependency_overrides (which encode "who is making this request") can't
    be clobbered by another client built later in the same test — a single
    shared app with mutated overrides was the actual bug caught by the
    first version of these cross-tenant tests, and it was in the test
    harness, not the product code. All instances share the same
    db_session, correctly modeling "two different authenticated users
    hitting the same running server, same database". Defaults to mounting
    just rules_router (test_rules.py's only consumer today); pass routers=
    explicitly for suites exercising a different router."""
    from gnt.db.session import get_session
    from gnt.routers import rules as rules_router

    def _build(routers: list | None = None) -> FastAPI:
        app = FastAPI()
        for router in routers if routers is not None else [rules_router.router]:
            app.include_router(router)

        async def _override_get_session() -> AsyncIterator[AsyncSession]:
            yield db_session

        app.dependency_overrides[get_session] = _override_get_session
        return app

    return _build


def make_org_client(
    app_factory,
    org_id: str,
    user_id: str = "user_test",
    role: str | None = None,
    auth_kind: str = "session",
    routers: list | None = None,
) -> AsyncClient:
    """An httpx client authenticated as a specific org/user/role/auth_kind,
    bypassing real session/API-key verification entirely via
    dependency_overrides — this is what lets cross-tenant tests act as
    "org A" and "org B" in the same test without needing real JWTs, and
    lets auth-boundary tests (require_session, require_admin) simulate an
    API-key-authenticated caller without a real key in the DB."""
    from gnt.auth.better_auth import (
        OrgContext,
        get_current_org,
        require_admin,
        require_admin_session,
        require_session,
    )

    app = app_factory(routers) if routers is not None else app_factory()
    org = OrgContext(org_id=org_id, user_id=user_id, role=role, auth_kind=auth_kind)

    async def _override_get_current_org() -> OrgContext:
        return org

    # require_admin/require_session/require_admin_session wrap get_current_org
    # via FastAPI's own Depends() at declaration time, so overriding
    # get_current_org alone doesn't affect them — override each directly too,
    # applying the same checks against our fixed OrgContext instead of a live
    # one.
    async def _override_require_admin() -> OrgContext:
        from fastapi import HTTPException, status

        if not org.is_admin:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin role required")
        return org

    async def _override_require_session() -> OrgContext:
        from fastapi import HTTPException, status

        if org.auth_kind != "session":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="this action requires a live sign-in, not an API key",
            )
        return org

    async def _override_require_admin_session() -> OrgContext:
        from fastapi import HTTPException, status

        if not org.is_admin:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin role required")
        if org.auth_kind != "session":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="this action requires a live sign-in, not an API key",
            )
        return org

    app.dependency_overrides[get_current_org] = _override_get_current_org
    app.dependency_overrides[require_admin] = _override_require_admin
    app.dependency_overrides[require_session] = _override_require_session
    app.dependency_overrides[require_admin_session] = _override_require_admin_session

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture
def org_a() -> str:
    return "org_test_a"


@pytest.fixture
def org_b() -> str:
    return "org_test_b"

"""send_weekly_digest_for_org / send_all_weekly_digests (the weekly
digest cron entrypoints). Mirrors test_tasks_staleness.py/
test_tasks_contradictions.py's split: the real per-org entrypoints are
exercised against a test Postgres, with the two genuinely external
dependencies mocked at their call boundary — gnt.org_contacts.
get_digest_recipients (an unverified-against-a-live-DB raw SQL query, see
that module's own docstring and test_org_contacts.py for its real,
un-mocked degrade-to-empty behavior) and gnt.email.send_weekly_digest (a
real Resend HTTP call, mocked here the same way test_tasks_contradictions.py
mocks create_issue for the GitHub client)."""

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from gnt.db.models import Org
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.db.session import get_cron_engine, get_cron_sessionmaker
from gnt.gap_tracking import log_gap
from gnt.roi_metrics import bump_roi_counters
from gnt.workers import tasks_digest
from gnt.workers.tasks_digest import send_all_weekly_digests, send_weekly_digest_for_org
from tests.conftest import TEST_DATABASE_URL


@pytest.fixture
def org_a() -> str:
    # Fresh per test -- roi_counters/rule_gaps are real Postgres rows this
    # test writes and reads back, same "own org id, no cross-test leakage"
    # reasoning test_tasks_staleness.py/test_tasks_contradictions.py apply.
    return f"org_test_digest_{uuid.uuid4().hex[:8]}"


@pytest.fixture
def org_b() -> str:
    return f"org_test_digest_{uuid.uuid4().hex[:8]}"


@pytest.fixture
async def _test_db_sessionmaker(monkeypatch):
    engine = create_async_engine(TEST_DATABASE_URL)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(tasks_digest, "get_sessionmaker", lambda: session_factory)
    yield session_factory
    await engine.dispose()


@pytest.fixture
def _mock_recipients(monkeypatch):
    """Returns a dict the test populates with {org_id: [emails]} -- an org
    missing from the dict resolves to [], the real "nothing to send to"
    case get_digest_recipients degrades to on its own (see
    test_org_contacts.py)."""
    recipients_by_org: dict[str, list[str]] = {}

    async def _get_digest_recipients(session, org_id):
        return recipients_by_org.get(org_id, [])

    monkeypatch.setattr("gnt.workers.tasks_digest.get_digest_recipients", _get_digest_recipients)
    return recipients_by_org


@pytest.fixture
def _mock_send(monkeypatch):
    calls: list[dict] = []

    async def _send_weekly_digest(to, org_id, summary):
        calls.append({"to": to, "org_id": org_id, "summary": summary})

    monkeypatch.setattr("gnt.workers.tasks_digest.send_weekly_digest", _send_weekly_digest)
    return calls


async def _seed_org(org_id: str) -> None:
    engine = create_async_engine(TEST_DATABASE_URL)
    try:
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with session_factory() as session:
            await ensure_org(session, org_id)
            await session.commit()
    finally:
        await engine.dispose()


async def _cleanup_org(org_id: str) -> None:
    from gnt.db.models import RoiCounter, RuleGap

    engine = create_async_engine(TEST_DATABASE_URL)
    try:
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with session_factory() as session:
            await scope_to_org(session, org_id)
            await session.execute(RoiCounter.__table__.delete().where(RoiCounter.org_id == org_id))
            await session.execute(RuleGap.__table__.delete().where(RuleGap.org_id == org_id))
            org = (await session.execute(select(Org).where(Org.id == org_id))).scalar_one_or_none()
            if org is not None:
                await session.delete(org)
            await session.commit()
    finally:
        await engine.dispose()


async def test_send_weekly_digest_for_org_skips_when_no_recipients(
    _test_db_sessionmaker, org_a, _mock_recipients, _mock_send, capsys
):
    await _seed_org(org_a)
    try:
        await send_weekly_digest_for_org(org_a)

        assert _mock_send == []
        out = capsys.readouterr().out
        assert "weekly_digest_skipped" in out
        assert org_a in out
    finally:
        await _cleanup_org(org_a)


async def test_send_weekly_digest_for_org_sends_the_real_aggregated_summary(
    _test_db_sessionmaker, org_a, _mock_recipients, _mock_send
):
    await _seed_org(org_a)
    _mock_recipients[org_a] = ["owner@example.com"]

    try:
        async with _test_db_sessionmaker() as session:
            await scope_to_org(session, org_a)
            await bump_roi_counters(session, org_a, {"rules_served": 4, "actions_checked": 2, "actions_blocked": 1})
            await log_gap(session, org_a, "search_rules", "uncovered query")

        await send_weekly_digest_for_org(org_a)

        assert len(_mock_send) == 1
        call = _mock_send[0]
        assert call["to"] == ["owner@example.com"]
        assert call["org_id"] == org_a
        assert call["summary"]["roi"]["current"]["rules_served"] == 4
        assert call["summary"]["roi"]["current"]["actions_checked"] == 2
        assert call["summary"]["roi"]["current"]["actions_blocked"] == 1
        assert call["summary"]["gaps"]["current"] == 1
        assert call["summary"]["stale_due_count"] == 0
    finally:
        await _cleanup_org(org_a)


async def test_send_all_weekly_digests_processes_each_org_in_its_own_scope(
    _test_db_sessionmaker, org_a, org_b, _mock_recipients, _mock_send
):
    """The cron entrypoint's own tenant-isolation guarantee, same shape
    test_tasks_staleness.py/test_tasks_contradictions.py prove for their
    own jobs: org B has no recipient and must never get a digest, and org
    A's aggregated numbers must never include org B's activity."""
    get_cron_engine.cache_clear()
    get_cron_sessionmaker.cache_clear()

    await _seed_org(org_a)
    await _seed_org(org_b)
    _mock_recipients[org_a] = ["owner-a@example.com"]
    # org_b deliberately left out of _mock_recipients -- no recipient.

    try:
        async with _test_db_sessionmaker() as session:
            await scope_to_org(session, org_a)
            await bump_roi_counters(session, org_a, {"rules_served": 3})
            await scope_to_org(session, org_b)
            await bump_roi_counters(session, org_b, {"rules_served": 99})

        await send_all_weekly_digests({})

        assert len(_mock_send) == 1
        assert _mock_send[0]["org_id"] == org_a
        assert _mock_send[0]["summary"]["roi"]["current"]["rules_served"] == 3
    finally:
        await get_cron_engine().dispose()
        get_cron_engine.cache_clear()
        get_cron_sessionmaker.cache_clear()
        await _cleanup_org(org_a)
        await _cleanup_org(org_b)

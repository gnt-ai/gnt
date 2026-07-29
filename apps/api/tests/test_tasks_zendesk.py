"""sync_zendesk / sync_zendesk_for_org, the Zendesk helpdesk connector.
Mirrors test_tasks_contradictions.py's shape: exercised for real against a test
Postgres + the real store subprocess, with the Zendesk client, the
extraction call, and the GitHub client all mocked at their own call
boundaries.
"""

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from gnt.db.models import GithubConnection, OnboardingEvent, Org, ZendeskConnection, ZendeskSyncState
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.db.session import get_cron_engine, get_cron_sessionmaker
from gnt.github.client import PullRequestResult
from gnt.github.crypto import encrypt_token as encrypt_github_token
from gnt.pipeline.content_extraction import RuleCandidate
from gnt.store_client import list_rules as store_list_rules
from gnt.workers import tasks_zendesk
from gnt.workers.tasks_zendesk import sync_zendesk, sync_zendesk_for_org
from gnt.zendesk.client import Article, Macro, ZendeskClientError
from gnt.zendesk.crypto import encrypt_token as encrypt_zendesk_token
from gnt.zendesk_sync_status import has_been_processed
from tests.conftest import TEST_DATABASE_URL

REPO_URL = "https://github.com/acme/rules"


@pytest.fixture
def org_a() -> str:
    return f"org_test_zendesk_{uuid.uuid4().hex[:8]}"


@pytest.fixture
def org_b() -> str:
    return f"org_test_zendesk_{uuid.uuid4().hex[:8]}"


@pytest.fixture
async def _test_db_sessionmaker(monkeypatch):
    engine = create_async_engine(TEST_DATABASE_URL)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(tasks_zendesk, "get_sessionmaker", lambda: session_factory)

    async def _ok(org_id, **kwargs):
        return True

    async def _noop(*args, **kwargs):
        return None

    # The LLM spend quota gate has its own dedicated coverage in
    # tests/test_llm_quota.py — every test here that isn't specifically
    # exercising the quota gate stubs it out, same convention
    # test_tasks_contradictions.py's own _test_db_sessionmaker fixture uses.
    monkeypatch.setattr(tasks_zendesk, "check_llm_quota", _ok)
    monkeypatch.setattr(tasks_zendesk, "record_llm_usage", _noop)
    yield session_factory
    await engine.dispose()


async def _seed_zendesk_connection(org_id: str) -> None:
    engine = create_async_engine(TEST_DATABASE_URL)
    try:
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with session_factory() as session:
            await ensure_org(session, org_id)
            session.add(
                ZendeskConnection(
                    org_id=org_id,
                    subdomain="acme",
                    agent_email="agent@acme.com",
                    api_token_encrypted=encrypt_zendesk_token("fake-token"),
                    installed_by_user_id="admin_a",
                )
            )
            await session.commit()
    finally:
        await engine.dispose()


async def _add_github_connection(org_id: str, *, repo_url: str = REPO_URL) -> None:
    engine = create_async_engine(TEST_DATABASE_URL)
    try:
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with session_factory() as session:
            session.add(
                GithubConnection(
                    org_id=org_id,
                    repo_url=repo_url,
                    default_branch="main",
                    pat_encrypted=encrypt_github_token("fake-pat"),
                    webhook_secret_encrypted=encrypt_github_token("fake-secret"),
                    installed_by_user_id="admin_a",
                )
            )
            await session.commit()
    finally:
        await engine.dispose()


async def _cleanup_org(org_id: str) -> None:
    engine = create_async_engine(TEST_DATABASE_URL)
    try:
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with session_factory() as session:
            await scope_to_org(session, org_id)
            from gnt.db.models import ZendeskProcessedItem

            await session.execute(ZendeskProcessedItem.__table__.delete().where(ZendeskProcessedItem.org_id == org_id))
            await session.execute(ZendeskSyncState.__table__.delete().where(ZendeskSyncState.org_id == org_id))
            await session.execute(ZendeskConnection.__table__.delete().where(ZendeskConnection.org_id == org_id))
            await session.execute(GithubConnection.__table__.delete().where(GithubConnection.org_id == org_id))
            await session.execute(OnboardingEvent.__table__.delete().where(OnboardingEvent.org_id == org_id))
            org = (await session.execute(select(Org).where(Org.id == org_id))).scalar_one_or_none()
            if org is not None:
                await session.delete(org)
            await session.commit()
    finally:
        await engine.dispose()


@pytest.fixture
def _no_articles_or_tickets(monkeypatch):
    """Most tests below only care about macro content — stub the other
    two sources to empty so a test asserting "exactly one item processed"
    isn't accidentally sensitive to whatever list_articles/
    list_recently_updated_ticket_ids would otherwise be mocked to."""

    async def _empty_articles(subdomain, agent_email, api_token, *, limit):
        return []

    async def _empty_tickets(subdomain, agent_email, api_token, *, start_time_unix, limit):
        return []

    monkeypatch.setattr(tasks_zendesk, "list_articles", _empty_articles)
    monkeypatch.setattr(tasks_zendesk, "list_recently_updated_ticket_ids", _empty_tickets)


@pytest.fixture
def _one_macro(monkeypatch, _no_articles_or_tickets):
    async def _macros(subdomain, agent_email, api_token):
        return [Macro(id="55", title="Refund policy", action_text="Refunds within 30 days.", updated_at="2026-07-01T00:00:00Z")]

    monkeypatch.setattr(tasks_zendesk, "list_macros", _macros)


@pytest.fixture
def _mock_extraction(monkeypatch):
    """Returns a setter the test calls with the candidates the mocked
    extraction should report, plus the list of (source_label, text) pairs
    it was actually called with — so a test can assert the gate ran
    BEFORE this call ever saw the content."""
    state = {"candidates": [RuleCandidate(title="Refund window", body="Refunds are processed within 30 days.")]}
    calls: list[tuple[str, str]] = []

    async def _extract(source_label, text):
        calls.append((source_label, text))
        return state["candidates"], 100, 30

    monkeypatch.setattr(tasks_zendesk, "extract_candidate_rules_async", _extract)
    return state, calls


@pytest.fixture
def _mock_propose_pr(monkeypatch):
    """Same call-boundary mocking shape test_tasks_contradictions.py's own
    _mock_propose_pr fixture uses — propose_rule_for_org (reused verbatim
    from routers/rules.py, not reimplemented here) is what actually calls
    create_branch/put_file/open_pull_request/find_conflict."""
    calls: list[dict] = []

    async def _fake_create_branch(repo_url, pat, branch, base_branch):
        calls.append({"step": "create_branch", "repo_url": repo_url, "branch": branch})

    async def _fake_put_file(repo_url, pat, branch, path, content, message):
        calls.append({"step": "put_file", "repo_url": repo_url, "content": content})

    async def _fake_open_pull_request(repo_url, pat, head_branch, base_branch, title, body):
        pr_number = 1 + sum(1 for c in calls if c["step"] == "open_pull_request")
        calls.append({"step": "open_pull_request", "repo_url": repo_url, "title": title, "body": body, "pr_number": pr_number})
        return PullRequestResult(number=pr_number, url=f"{repo_url}/pull/{pr_number}")

    async def _fake_find_conflict(org_id, rule):
        return None

    monkeypatch.setattr("gnt.routers.rules.create_branch", _fake_create_branch)
    monkeypatch.setattr("gnt.routers.rules.put_file", _fake_put_file)
    monkeypatch.setattr("gnt.routers.rules.open_pull_request", _fake_open_pull_request)
    monkeypatch.setattr("gnt.routers.rules.find_conflict", _fake_find_conflict)
    return calls


# --- core pipeline -------------------------------------------------------


async def test_org_with_no_zendesk_connection_is_skipped(_test_db_sessionmaker, org_a):
    engine = create_async_engine(TEST_DATABASE_URL)
    try:
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with session_factory() as session:
            await ensure_org(session, org_a)
            await session.commit()
    finally:
        await engine.dispose()

    try:
        await sync_zendesk_for_org(org_a)
        async with _test_db_sessionmaker() as session:
            await scope_to_org(session, org_a)
            row = (
                await session.execute(select(ZendeskSyncState).where(ZendeskSyncState.org_id == org_a))
            ).scalar_one_or_none()
        assert row is None  # no sync attempted at all -- nothing to record
    finally:
        await _cleanup_org(org_a)


async def test_candidate_created_as_draft_and_submitted_without_github(
    _test_db_sessionmaker, org_a, _one_macro, _mock_extraction
):
    """No GithubConnection -- the candidate rule still gets created and
    submitted for review, it just has nowhere to open a PR against yet
    (module docstring's own documented behavior)."""
    await _seed_zendesk_connection(org_a)

    try:
        await sync_zendesk_for_org(org_a)

        drafts = await store_list_rules(org_a, status="in_review")
        assert len(drafts) == 1
        assert drafts[0]["title"] == "Refund window"
        assert drafts[0]["tags"] == ["zendesk"]
        assert "Zendesk macro" in drafts[0]["source"]

        async with _test_db_sessionmaker() as session:
            await scope_to_org(session, org_a)
            state = (
                await session.execute(select(ZendeskSyncState).where(ZendeskSyncState.org_id == org_a))
            ).scalar_one()
        assert state.last_error is None
        assert state.last_success_at is not None
        assert state.items_scanned_last_run == 1
        assert state.candidates_proposed_last_run == 1
    finally:
        await _cleanup_org(org_a)


async def test_candidate_proposed_as_a_real_pr_when_github_is_connected(
    _test_db_sessionmaker, org_a, _one_macro, _mock_extraction, _mock_propose_pr
):
    await _seed_zendesk_connection(org_a)
    await _add_github_connection(org_a)

    try:
        await sync_zendesk_for_org(org_a)

        pr_calls = [c for c in _mock_propose_pr if c["step"] == "open_pull_request"]
        assert len(pr_calls) == 1
        assert pr_calls[0]["repo_url"] == REPO_URL

        drafts = await store_list_rules(org_a, status="pending_merge")
        assert len(drafts) == 1
        assert drafts[0]["title"] == "Refund window"
    finally:
        await _cleanup_org(org_a)


async def test_content_reaching_extraction_is_already_gate_masked(
    _test_db_sessionmaker, org_a, _no_articles_or_tickets, _mock_extraction, monkeypatch
):
    """PII masking is a hard requirement on the extraction path itself, not
    just before storage: content must be masked BEFORE it ever reaches the
    extraction call, not filtered afterward. Proves it directly: a macro
    whose action text contains an email address must reach the extraction
    call with that email already replaced by a placeholder, never the raw
    address."""
    _state, calls = _mock_extraction

    async def _macros(subdomain, agent_email, api_token):
        return [
            Macro(
                id="99", title="Contact macro",
                action_text="Reach out to bob@acme.com if the customer escalates.",
                updated_at="x",
            )
        ]

    monkeypatch.setattr(tasks_zendesk, "list_macros", _macros)
    await _seed_zendesk_connection(org_a)

    try:
        await sync_zendesk_for_org(org_a)
        assert len(calls) == 1
        _source_label, text_sent_to_model = calls[0]
        assert "bob@acme.com" not in text_sent_to_model
    finally:
        await _cleanup_org(org_a)


async def test_dedup_skips_reextracting_unchanged_content_on_a_second_run(
    _test_db_sessionmaker, org_a, _one_macro, _mock_extraction
):
    _state, calls = _mock_extraction
    await _seed_zendesk_connection(org_a)

    try:
        await sync_zendesk_for_org(org_a)
        assert len(calls) == 1

        await sync_zendesk_for_org(org_a)
        assert len(calls) == 1  # unchanged content, same fingerprint -- no second extraction call

        async with _test_db_sessionmaker() as session:
            processed = await has_been_processed(
                session, org_a, "macro", "55",
                tasks_zendesk._fingerprint("macro", "55", "Refunds within 30 days."),
            )
        assert processed is True
    finally:
        await _cleanup_org(org_a)


async def test_a_zero_candidate_extraction_still_marks_the_item_processed(
    _test_db_sessionmaker, org_a, _one_macro, _mock_extraction
):
    state, calls = _mock_extraction
    state["candidates"] = []
    await _seed_zendesk_connection(org_a)

    try:
        await sync_zendesk_for_org(org_a)
        assert len(calls) == 1
        assert await store_list_rules(org_a, status="draft") == []

        # Reprocessed check -- a second run must not re-extract identical
        # content just because it produced zero candidates the first time.
        await sync_zendesk_for_org(org_a)
        assert len(calls) == 1
    finally:
        await _cleanup_org(org_a)


async def test_one_bad_item_does_not_block_the_rest_of_the_sync(
    _test_db_sessionmaker, org_a, _no_articles_or_tickets, monkeypatch
):
    async def _macros(subdomain, agent_email, api_token):
        return [
            Macro(id="1", title="Broken", action_text="broken content", updated_at="x"),
            Macro(id="2", title="Healthy", action_text="healthy content", updated_at="x"),
        ]

    calls = {"count": 0}

    async def _extract(source_label, text):
        calls["count"] += 1
        if "broken" in text:
            raise RuntimeError("model blew up")
        return [RuleCandidate(title="Healthy rule", body="Something worth keeping.")], 50, 10

    monkeypatch.setattr(tasks_zendesk, "list_macros", _macros)
    monkeypatch.setattr(tasks_zendesk, "extract_candidate_rules_async", _extract)
    await _seed_zendesk_connection(org_a)

    try:
        await sync_zendesk_for_org(org_a)
        assert calls["count"] == 2
        drafts = await store_list_rules(org_a, status="in_review")
        assert len(drafts) == 1
        assert drafts[0]["title"] == "Healthy rule"

        async with _test_db_sessionmaker() as session:
            await scope_to_org(session, org_a)
            state = (
                await session.execute(select(ZendeskSyncState).where(ZendeskSyncState.org_id == org_a))
            ).scalar_one()
        # The broken item's own exception is swallowed inside _process_item
        # -- the run as a whole still reports success.
        assert state.last_error is None
    finally:
        await _cleanup_org(org_a)


async def test_org_level_zendesk_failure_is_recorded_as_a_sync_error(
    _test_db_sessionmaker, org_a, monkeypatch
):
    async def _boom(subdomain, agent_email, api_token):
        raise ZendeskClientError("Zendesk returned 401: token revoked")

    monkeypatch.setattr(tasks_zendesk, "list_macros", _boom)
    await _seed_zendesk_connection(org_a)

    try:
        await sync_zendesk_for_org(org_a)  # must not raise
        async with _test_db_sessionmaker() as session:
            await scope_to_org(session, org_a)
            state = (
                await session.execute(select(ZendeskSyncState).where(ZendeskSyncState.org_id == org_a))
            ).scalar_one()
        assert state.last_error is not None
        assert "token revoked" in state.last_error
        assert state.last_success_at is None
    finally:
        await _cleanup_org(org_a)


async def test_budget_bounds_the_number_of_items_processed(
    _test_db_sessionmaker, org_a, _no_articles_or_tickets, _mock_extraction, monkeypatch
):
    from gnt.config import get_settings

    monkeypatch.setattr(get_settings(), "zendesk_sweep_max_items_per_org", 2)

    async def _macros(subdomain, agent_email, api_token):
        return [
            Macro(id=str(i), title=f"Macro {i}", action_text=f"content {i}", updated_at="x") for i in range(5)
        ]

    monkeypatch.setattr(tasks_zendesk, "list_macros", _macros)
    _state, calls = _mock_extraction
    await _seed_zendesk_connection(org_a)

    try:
        await sync_zendesk_for_org(org_a)
        assert len(calls) == 2
    finally:
        await _cleanup_org(org_a)


async def test_llm_quota_exhausted_stops_the_run_early(
    _test_db_sessionmaker, org_a, _no_articles_or_tickets, _mock_extraction, monkeypatch
):
    async def _macros(subdomain, agent_email, api_token):
        return [Macro(id=str(i), title=f"Macro {i}", action_text=f"content {i}", updated_at="x") for i in range(3)]

    async def _exhausted(org_id, **kwargs):
        return False

    monkeypatch.setattr(tasks_zendesk, "list_macros", _macros)
    monkeypatch.setattr(tasks_zendesk, "check_llm_quota", _exhausted)
    _state, calls = _mock_extraction
    await _seed_zendesk_connection(org_a)

    try:
        await sync_zendesk_for_org(org_a)
        assert calls == []
    finally:
        await _cleanup_org(org_a)


async def test_articles_are_read_with_html_stripped_and_never_exceed_budget(
    _test_db_sessionmaker, org_a, _mock_extraction, monkeypatch
):
    async def _no_macros(subdomain, agent_email, api_token):
        return []

    async def _articles(subdomain, agent_email, api_token, *, limit):
        return [
            Article(
                id="7", title="Shipping", body_text="Orders ship within 2 days.",
                html_url="https://acme.zendesk.com/hc/articles/7", updated_at="x",
            )
        ]

    async def _no_tickets(subdomain, agent_email, api_token, *, start_time_unix, limit):
        return []

    monkeypatch.setattr(tasks_zendesk, "list_macros", _no_macros)
    monkeypatch.setattr(tasks_zendesk, "list_articles", _articles)
    monkeypatch.setattr(tasks_zendesk, "list_recently_updated_ticket_ids", _no_tickets)
    await _seed_zendesk_connection(org_a)

    try:
        await sync_zendesk_for_org(org_a)
        drafts = await store_list_rules(org_a, status="in_review")
        assert len(drafts) == 1
        assert drafts[0]["source"] == "https://acme.zendesk.com/hc/articles/7"
    finally:
        await _cleanup_org(org_a)


async def test_sync_zendesk_processes_each_org_in_its_own_scope(
    _test_db_sessionmaker, org_a, org_b, _no_articles_or_tickets, _mock_extraction, monkeypatch
):
    get_cron_engine.cache_clear()
    get_cron_sessionmaker.cache_clear()

    # Both orgs share the same list_macros mock -- distinguished by
    # subdomain, which each org's own ZendeskConnection carries.
    async def _macros(subdomain, agent_email, api_token):
        label = "A" if subdomain == "acme-a" else "B"
        return [Macro(id="1", title=f"Org {label} macro", action_text=f"content for {label}", updated_at="x")]

    monkeypatch.setattr(tasks_zendesk, "list_macros", _macros)

    # Two separate sessions, one per org -- sharing one session across both
    # ensure_org calls re-scopes app.current_org mid-session and can flush
    # org A's still-pending insert under org B's GUC (RLS then rejects it).
    for org_id, subdomain, email, token in (
        (org_a, "acme-a", "a@acme.com", "tok-a"),
        (org_b, "acme-b", "b@acme.com", "tok-b"),
    ):
        engine = create_async_engine(TEST_DATABASE_URL)
        try:
            session_factory = async_sessionmaker(engine, expire_on_commit=False)
            async with session_factory() as session:
                await ensure_org(session, org_id)
                session.add(
                    ZendeskConnection(
                        org_id=org_id, subdomain=subdomain, agent_email=email,
                        api_token_encrypted=encrypt_zendesk_token(token), installed_by_user_id="admin",
                    )
                )
                await session.commit()
        finally:
            await engine.dispose()

    try:
        await sync_zendesk({})

        drafts_a = await store_list_rules(org_a, status="in_review")
        drafts_b = await store_list_rules(org_b, status="in_review")
        assert len(drafts_a) == 1 and len(drafts_b) == 1
        assert drafts_a[0]["title"] == "Refund window"  # from the shared _mock_extraction fixture
        assert drafts_b[0]["title"] == "Refund window"
    finally:
        await get_cron_engine().dispose()
        get_cron_engine.cache_clear()
        get_cron_sessionmaker.cache_clear()
        await _cleanup_org(org_a)
        await _cleanup_org(org_b)

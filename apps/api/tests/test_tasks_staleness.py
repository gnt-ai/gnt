"""compute_rule_staleness / compute_staleness_for_org / write_staleness_rows,
the nightly staleness cron. write_staleness_rows is
tested directly against db_session (same shape test_compile_skill_pack.py
uses for compile_skill_pack — a session-taking function a fixture already
controls). compute_staleness_for_org and compute_rule_staleness open their
own session via get_sessionmaker(), which (like tasks_compile.py's
compile_skills, itself never invoked directly in this test suite either —
see its own module) reads get_settings().database_url unsuffixed outside
of db_session's monkeypatch of gnt.mcp_server.*'s get_sessionmaker. The
two tests here that do exercise those entrypoints for real (proving the
actual enumerate-orgs-then-scope-each wiring, not just the DB layer
underneath it) monkeypatch gnt.workers.tasks_staleness.get_sessionmaker
onto a session factory bound to TEST_DATABASE_URL, the same pattern
conftest.py's db_session fixture already uses for the MCP server module.

The refresh-or-deprecate sweep — a follow-up to the staleness cron above
that actively refreshes or deprecates stale rules instead of just flagging
them — gets its own section below, mirroring test_tasks_contradictions.py's
split: sweep_staleness_
refresh_for_org is exercised for real against a test Postgres + the real
store subprocess, with the GitHub client mocked at its call boundary
(same mocking shape that file uses for judge_conflict/create_issue).
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from gnt.approval import hash_approval_content, sign_approval
from gnt.db.models import GithubConnection, Org, RuleStaleness, StalenessRefreshProposal
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.db.session import get_cron_engine, get_cron_sessionmaker
from gnt.github.client import GithubClientError, PullRequestResult
from gnt.github.crypto import encrypt_token
from gnt.staleness import STALE_THRESHOLD_DAYS
from gnt.staleness_refresh import has_been_proposed
from gnt.store_client import put_rule
from gnt.workers import tasks_staleness
from gnt.workers.tasks_staleness import (
    compute_rule_staleness,
    compute_staleness_for_org,
    sweep_staleness_refresh_for_org,
    write_staleness_rows,
)
from tests.conftest import TEST_DATABASE_URL

REPO_URL = "https://github.com/acme/rules"


@pytest.fixture
def org_a() -> str:
    # Fresh per test, not conftest's shared "org_test_a" — the store
    # subprocess (apps/store, pglite) persists rules for the whole test
    # session, unlike db_session's per-test rollback, so a shared org id
    # here would leak one test's approved rules into another's.
    return f"org_test_stale_{uuid.uuid4().hex[:8]}"


@pytest.fixture
def org_b() -> str:
    return f"org_test_stale_{uuid.uuid4().hex[:8]}"


def _rule_dict(
    org_id: str, slug: str, title: str, *, approved_at: str, source_citations: list | None = None
) -> dict:
    return {
        "slug": slug,
        "org": org_id,
        "title": title,
        "body": f"body for {title}",
        "status": "draft",
        "confidence": 0.7,
        "ownerId": "test_user",
        "sourceCitations": source_citations or [],
        "tags": [],
        "lastValidatedAt": None,
        "version": 1,
        "supersededBy": None,
        "previousVersionId": None,
        "approvedBy": None,
        "approvedAt": None,
        "createdAt": approved_at,
        "prNumber": None,
        "prUrl": None,
    }


async def _approve_directly_via_store(org_id: str, rule: dict, *, approved_at: str) -> dict:
    """Same shortcut test_rules.py/test_mcp_tools.py use — there's no
    HTTP path to "approved" anymore (a human merging a real GitHub PR is
    the only production path)."""
    rule = dict(rule)
    rule["status"] = "approved"
    rule["approvedBy"] = "admin_a"
    rule["approvedAt"] = approved_at
    content_hash = hash_approval_content(
        title=rule["title"], body=rule["body"], tags=rule["tags"], status=rule["status"]
    )
    signature = sign_approval(
        org_id=org_id, slug=rule["slug"], version=rule["version"], content_hash=content_hash
    )
    await put_rule(rule, approval_signature=signature)
    return rule


def _iso_days_ago(days: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


# --- write_staleness_rows: pure DB semantics, via db_session -------------


async def test_write_staleness_rows_upserts_new_rows(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()
    await scope_to_org(db_session, org_a)

    now = datetime.now(timezone.utc)
    rows = [
        {
            "org_id": org_a,
            "rule_slug": "rules/one",
            "title": "Rule one",
            "age_days": 50.0,
            "freshness_score": 0.6,
            "is_stale": True,
            "computed_at": now,
        }
    ]
    await write_staleness_rows(db_session, org_a, rows)
    await db_session.commit()

    result = (
        await db_session.execute(select(RuleStaleness).where(RuleStaleness.org_id == org_a))
    ).scalars().all()
    assert len(result) == 1
    assert result[0].rule_slug == "rules/one"
    assert result[0].age_days == 50.0
    assert result[0].is_stale is True


async def test_write_staleness_rows_updates_existing_row_on_conflict(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()
    await scope_to_org(db_session, org_a)

    stale_row = {
        "org_id": org_a,
        "rule_slug": "rules/one",
        "title": "Rule one",
        "age_days": 10.0,
        "freshness_score": 0.9,
        "is_stale": False,
        "computed_at": datetime.now(timezone.utc) - timedelta(days=1),
    }
    await write_staleness_rows(db_session, org_a, [stale_row])
    await db_session.commit()

    fresher_row = dict(stale_row, age_days=45.0, freshness_score=0.6, is_stale=True)
    await write_staleness_rows(db_session, org_a, [fresher_row])
    await db_session.commit()

    result = (
        await db_session.execute(select(RuleStaleness).where(RuleStaleness.org_id == org_a))
    ).scalars().all()
    assert len(result) == 1
    assert result[0].age_days == 45.0
    assert result[0].is_stale is True


async def test_write_staleness_rows_deletes_rows_no_longer_in_the_approved_set(db_session, org_a):
    """A rule that gets deprecated or superseded between two runs must not
    keep showing up in `gnt stale` forever off a stale snapshot."""
    await ensure_org(db_session, org_a)
    await db_session.commit()
    await scope_to_org(db_session, org_a)

    now = datetime.now(timezone.utc)
    await write_staleness_rows(
        db_session,
        org_a,
        [
            {
                "org_id": org_a,
                "rule_slug": "rules/still-approved",
                "title": "Still approved",
                "age_days": 50.0,
                "freshness_score": 0.6,
                "is_stale": True,
                "computed_at": now,
            },
            {
                "org_id": org_a,
                "rule_slug": "rules/now-deprecated",
                "title": "Now deprecated",
                "age_days": 60.0,
                "freshness_score": 0.5,
                "is_stale": True,
                "computed_at": now,
            },
        ],
    )
    await db_session.commit()

    # Second run: "now-deprecated" no longer comes back from the store.
    await write_staleness_rows(
        db_session,
        org_a,
        [
            {
                "org_id": org_a,
                "rule_slug": "rules/still-approved",
                "title": "Still approved",
                "age_days": 51.0,
                "freshness_score": 0.59,
                "is_stale": True,
                "computed_at": now,
            },
        ],
    )
    await db_session.commit()

    result = (
        await db_session.execute(select(RuleStaleness).where(RuleStaleness.org_id == org_a))
    ).scalars().all()
    assert len(result) == 1
    assert result[0].rule_slug == "rules/still-approved"
    assert result[0].age_days == 51.0


async def test_write_staleness_rows_empty_set_clears_the_org(db_session, org_a):
    await ensure_org(db_session, org_a)
    await db_session.commit()
    await scope_to_org(db_session, org_a)

    now = datetime.now(timezone.utc)
    await write_staleness_rows(
        db_session,
        org_a,
        [
            {
                "org_id": org_a,
                "rule_slug": "rules/one",
                "title": "Rule one",
                "age_days": 50.0,
                "freshness_score": 0.6,
                "is_stale": True,
                "computed_at": now,
            }
        ],
    )
    await db_session.commit()

    await write_staleness_rows(db_session, org_a, [])
    await db_session.commit()

    result = (
        await db_session.execute(select(RuleStaleness).where(RuleStaleness.org_id == org_a))
    ).scalars().all()
    assert result == []


async def test_write_staleness_rows_is_org_isolated_by_rls(db_session, org_a, org_b):
    await ensure_org(db_session, org_a)
    await ensure_org(db_session, org_b)
    await db_session.commit()
    await scope_to_org(db_session, org_a)

    now = datetime.now(timezone.utc)
    await write_staleness_rows(
        db_session,
        org_a,
        [
            {
                "org_id": org_a,
                "rule_slug": "rules/org-a",
                "title": "Org A rule",
                "age_days": 50.0,
                "freshness_score": 0.6,
                "is_stale": True,
                "computed_at": now,
            }
        ],
    )
    await db_session.commit()

    await scope_to_org(db_session, org_b)
    org_b_view = (await db_session.execute(select(RuleStaleness))).scalars().all()
    assert org_b_view == []

    await scope_to_org(db_session, org_a)
    org_a_view = (await db_session.execute(select(RuleStaleness))).scalars().all()
    assert len(org_a_view) == 1


# --- compute_staleness_for_org / compute_rule_staleness: the real entrypoints ---


@pytest.fixture
async def _test_db_sessionmaker(monkeypatch):
    """Points gnt.workers.tasks_staleness's own get_sessionmaker() at
    TEST_DATABASE_URL instead of get_settings().database_url (which isn't
    test-suffixed the way CRON_DATABASE_URL is — see this module's own
    docstring). Mirrors conftest.py's db_session fixture, which does the
    same monkeypatch for gnt.mcp_server.server/auth."""
    engine = create_async_engine(TEST_DATABASE_URL)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(tasks_staleness, "get_sessionmaker", lambda: session_factory)
    yield session_factory
    await engine.dispose()


async def _seed_org_committed(org_id: str) -> None:
    """compute_staleness_for_org/compute_rule_staleness open their own,
    genuinely separate connection (see this module's own docstring) —
    db_session's per-test transaction (rolled back at teardown, never
    really committed to Postgres) is invisible to it, so an org that
    should exist by the time that separate connection runs has to be
    seeded through one of its own, with a real COMMIT."""
    engine = create_async_engine(TEST_DATABASE_URL)
    try:
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with session_factory() as session:
            await ensure_org(session, org_id)
            await session.commit()
    finally:
        await engine.dispose()


async def _cleanup_org(org_id: str) -> None:
    engine = create_async_engine(TEST_DATABASE_URL)
    try:
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with session_factory() as session:
            await scope_to_org(session, org_id)
            await session.execute(delete(RuleStaleness).where(RuleStaleness.org_id == org_id))
            # The refresh-or-deprecate sweep added rows that FK to orgs.id —
            # a test that seeds a GithubConnection and/or a
            # StalenessRefreshProposal row must clear both before the org
            # row itself can be deleted.
            await session.execute(
                delete(StalenessRefreshProposal).where(StalenessRefreshProposal.org_id == org_id)
            )
            await session.execute(delete(GithubConnection).where(GithubConnection.org_id == org_id))
            org = (await session.execute(select(Org).where(Org.id == org_id))).scalar_one_or_none()
            if org is not None:
                await session.delete(org)
            await session.commit()
    finally:
        await engine.dispose()


async def test_compute_staleness_for_org_writes_rows_from_real_store(_test_db_sessionmaker, org_a):
    await _seed_org_committed(org_a)

    old_rule = await _approve_directly_via_store(
        org_a,
        _rule_dict(org_a, f"rules/{uuid.uuid4()}", "Old rule", approved_at=_iso_days_ago(60)),
        approved_at=_iso_days_ago(60),
    )
    fresh_rule = await _approve_directly_via_store(
        org_a,
        _rule_dict(org_a, f"rules/{uuid.uuid4()}", "Fresh rule", approved_at=_iso_days_ago(1)),
        approved_at=_iso_days_ago(1),
    )

    try:
        await compute_staleness_for_org(org_a)

        async with _test_db_sessionmaker() as session:
            await scope_to_org(session, org_a)
            rows = (
                await session.execute(select(RuleStaleness).where(RuleStaleness.org_id == org_a))
            ).scalars().all()

        by_slug = {row.rule_slug: row for row in rows}
        assert by_slug[old_rule["slug"]].is_stale is True
        assert by_slug[old_rule["slug"]].age_days >= STALE_THRESHOLD_DAYS
        assert by_slug[fresh_rule["slug"]].is_stale is False
    finally:
        await _cleanup_org(org_a)


async def test_compute_rule_staleness_processes_each_org_in_its_own_scope(
    _test_db_sessionmaker, org_a, org_b
):
    """The cron entrypoint's own tenant-isolation guarantee: org B's
    approved rules must never end up attributed to org A's staleness
    snapshot (or vice versa), proven by running the real multi-org
    enumeration (through the real, already test-suffixed
    get_cron_sessionmaker — see conftest.py's CRON_DATABASE_URL
    handling) rather than calling compute_staleness_for_org once per org
    directly."""
    get_cron_engine.cache_clear()
    get_cron_sessionmaker.cache_clear()

    await _seed_org_committed(org_a)
    await _seed_org_committed(org_b)

    rule_a = await _approve_directly_via_store(
        org_a,
        _rule_dict(org_a, f"rules/{uuid.uuid4()}", "Org A rule", approved_at=_iso_days_ago(50)),
        approved_at=_iso_days_ago(50),
    )
    rule_b = await _approve_directly_via_store(
        org_b,
        _rule_dict(org_b, f"rules/{uuid.uuid4()}", "Org B rule", approved_at=_iso_days_ago(50)),
        approved_at=_iso_days_ago(50),
    )

    try:
        await compute_rule_staleness({})

        async with _test_db_sessionmaker() as session:
            await scope_to_org(session, org_a)
            org_a_rows = (
                await session.execute(select(RuleStaleness).where(RuleStaleness.org_id == org_a))
            ).scalars().all()

            await scope_to_org(session, org_b)
            org_b_rows = (
                await session.execute(select(RuleStaleness).where(RuleStaleness.org_id == org_b))
            ).scalars().all()

        assert {r.rule_slug for r in org_a_rows} == {rule_a["slug"]}
        assert {r.rule_slug for r in org_b_rows} == {rule_b["slug"]}
    finally:
        await get_cron_engine().dispose()
        get_cron_engine.cache_clear()
        get_cron_sessionmaker.cache_clear()
        await _cleanup_org(org_a)
        await _cleanup_org(org_b)


# --- sweep_staleness_refresh_for_org: the refresh-or-deprecate sweep ----


_QUALIFYING_CITATION = [
    {
        "sourcePath": "docs/refunds.md",
        "startLine": 1,
        "endLine": 3,
        "walker": "repo-scan",
        "excerpt": "Refunds must be processed within 30 days.",
    }
]


async def _seed_org_with_github(org_id: str, *, repo_url: str = REPO_URL) -> None:
    engine = create_async_engine(TEST_DATABASE_URL)
    try:
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with session_factory() as session:
            await ensure_org(session, org_id)
            session.add(
                GithubConnection(
                    org_id=org_id,
                    repo_url=repo_url,
                    default_branch="main",
                    pat_encrypted=encrypt_token("fake-pat"),
                    webhook_secret_encrypted=encrypt_token("fake-secret"),
                    installed_by_user_id="admin_a",
                )
            )
            await session.commit()
    finally:
        await engine.dispose()


@pytest.fixture
def _mock_pr_flow(monkeypatch):
    """Mocks the three GitHub write calls _propose_flag makes
    (create_branch, put_file, open_pull_request) at their
    gnt.workers.tasks_staleness call boundary — same shape
    test_tasks_contradictions.py's _mock_create_issue mocks create_issue.
    Returns the list of opened PRs so a test can assert on exactly what
    the sweep proposed, without a real GitHub call."""
    prs: list[dict] = []

    async def _create_branch(repo_url, pat, branch, base_branch):
        return None

    async def _put_file(repo_url, pat, branch, path, content, message):
        return None

    async def _open_pull_request(repo_url, pat, head_branch, base_branch, title, body):
        prs.append({"repo_url": repo_url, "branch": head_branch, "title": title, "body": body})
        return PullRequestResult(number=len(prs), url=f"{repo_url}/pull/{len(prs)}")

    monkeypatch.setattr(tasks_staleness, "create_branch", _create_branch)
    monkeypatch.setattr(tasks_staleness, "put_file", _put_file)
    monkeypatch.setattr(tasks_staleness, "open_pull_request", _open_pull_request)
    return prs


async def _stale_rule_with_citation(
    org_id: str, title: str = "Refund policy", *, source_citations: list | None = None
) -> dict:
    return await _approve_directly_via_store(
        org_id,
        _rule_dict(
            org_id,
            f"rules/{uuid.uuid4()}",
            title,
            approved_at=_iso_days_ago(60),
            source_citations=_QUALIFYING_CITATION if source_citations is None else source_citations,
        ),
        approved_at=_iso_days_ago(60),
    )


async def test_stale_rule_with_unchanged_source_produces_no_action(
    _test_db_sessionmaker, org_a, _mock_pr_flow, monkeypatch
):
    await _seed_org_with_github(org_a)

    async def _fake_get_file_content(repo_url, pat, path, ref):
        return "# Refund policy\n\nRefunds must be processed within 30 days.\n\nMore detail."

    monkeypatch.setattr(tasks_staleness, "get_file_content", _fake_get_file_content)
    rule = await _stale_rule_with_citation(org_a)

    try:
        await sweep_staleness_refresh_for_org(org_a, [rule])
        assert _mock_pr_flow == []

        async with _test_db_sessionmaker() as session:
            proposed = await has_been_proposed(session, org_a, rule["slug"], "refresh", "anything")
        assert proposed is False
    finally:
        await _cleanup_org(org_a)


async def test_stale_rule_source_file_gone_proposes_deprecate_flag(_test_db_sessionmaker, org_a, _mock_pr_flow, monkeypatch):
    """Exercises the real entrypoint (compute_staleness_for_org), not just
    sweep_staleness_refresh_for_org directly, so at least one case in this
    file proves the actual "flag a stale rule, then act on it" wiring end
    to end, the same reasoning test_compute_staleness_for_org_writes_rows_
    from_real_store above already applies to the passive half."""
    await _seed_org_with_github(org_a)

    async def _fake_get_file_content(repo_url, pat, path, ref):
        raise GithubClientError(f"could not read {path} (404)", status_code=404)

    monkeypatch.setattr(tasks_staleness, "get_file_content", _fake_get_file_content)
    rule = await _stale_rule_with_citation(org_a, "Refund policy")

    try:
        await compute_staleness_for_org(org_a)

        assert len(_mock_pr_flow) == 1
        assert _mock_pr_flow[0]["repo_url"] == REPO_URL
        assert "Deprecate" in _mock_pr_flow[0]["title"]
        assert "no longer exists" in _mock_pr_flow[0]["body"]
        assert "docs/refunds.md" in _mock_pr_flow[0]["body"]

        async with _test_db_sessionmaker() as session:
            await scope_to_org(session, org_a)
            rows = (
                await session.execute(
                    select(StalenessRefreshProposal).where(StalenessRefreshProposal.org_id == org_a)
                )
            ).scalars().all()
        assert len(rows) == 1
        assert rows[0].rule_slug == rule["slug"]
        assert rows[0].reason == "deprecate"
        assert rows[0].pr_number == 1
    finally:
        await _cleanup_org(org_a)


async def test_stale_rule_source_changed_proposes_refresh_flag_with_diff_visible(
    _test_db_sessionmaker, org_a, _mock_pr_flow, monkeypatch
):
    async def _fake_get_file_content(repo_url, pat, path, ref):
        return "# Refund policy\n\nRefunds must be processed within 14 days now.\n"

    monkeypatch.setattr(tasks_staleness, "get_file_content", _fake_get_file_content)
    await _seed_org_with_github(org_a)
    rule = await _stale_rule_with_citation(org_a)

    try:
        await sweep_staleness_refresh_for_org(org_a, [rule])

        assert len(_mock_pr_flow) == 1
        body = _mock_pr_flow[0]["body"]
        assert "Refresh" in _mock_pr_flow[0]["title"]
        # Both the originally captured excerpt and the current file's
        # content need to be visible in the proposed body -- a reviewer
        # deciding whether this is a real drift shouldn't have to open the
        # diff to see what changed.
        assert "Refunds must be processed within 30 days." in body
        assert "Refunds must be processed within 14 days now." in body

        async with _test_db_sessionmaker() as session:
            await scope_to_org(session, org_a)
            rows = (
                await session.execute(
                    select(StalenessRefreshProposal).where(StalenessRefreshProposal.org_id == org_a)
                )
            ).scalars().all()
        assert len(rows) == 1
        assert rows[0].reason == "refresh"
    finally:
        await _cleanup_org(org_a)


async def test_stale_rule_without_qualifying_citation_produces_no_action(
    _test_db_sessionmaker, org_a, _mock_pr_flow, monkeypatch
):
    """No source_citations at all -- starter-pack/webhook-ingested/
    hand-typed rules all look like this. Exactly today's (pre-3.2)
    behavior: staleness gets flagged, nothing gets proposed."""

    async def _fail_if_called(repo_url, pat, path, ref):
        raise AssertionError("get_file_content should never run for a rule with no qualifying citation")

    monkeypatch.setattr(tasks_staleness, "get_file_content", _fail_if_called)
    await _seed_org_with_github(org_a)
    rule = await _stale_rule_with_citation(org_a, source_citations=[])

    try:
        await sweep_staleness_refresh_for_org(org_a, [rule])
        assert _mock_pr_flow == []
    finally:
        await _cleanup_org(org_a)


async def test_stale_rule_ignores_a_notion_export_citation(_test_db_sessionmaker, org_a, _mock_pr_flow, monkeypatch):
    """A notion-export citation has no live, re-fetchable GitHub path --
    it must not qualify even though it has a sourcePath."""

    async def _fail_if_called(repo_url, pat, path, ref):
        raise AssertionError("get_file_content should never run for a notion-export-only citation")

    monkeypatch.setattr(tasks_staleness, "get_file_content", _fail_if_called)
    await _seed_org_with_github(org_a)
    rule = await _stale_rule_with_citation(
        org_a,
        source_citations=[
            {
                "sourcePath": "Refund Policy.md",
                "startLine": 1,
                "endLine": 2,
                "walker": "notion-export",
                "excerpt": "Refunds must be processed within 30 days.",
            }
        ],
    )

    try:
        await sweep_staleness_refresh_for_org(org_a, [rule])
        assert _mock_pr_flow == []
    finally:
        await _cleanup_org(org_a)


async def test_stale_rule_with_qualifying_citation_but_no_github_connection_produces_no_action(
    _test_db_sessionmaker, org_a, _mock_pr_flow, monkeypatch
):
    """Same "no action" outcome as no qualifying citation, but for the
    other half of the gate: a qualifying citation with nowhere to open a
    PR against."""

    async def _fail_if_called(repo_url, pat, path, ref):
        raise AssertionError("get_file_content should never run with no GithubConnection")

    monkeypatch.setattr(tasks_staleness, "get_file_content", _fail_if_called)
    await _seed_org_committed(org_a)  # no GithubConnection
    rule = await _stale_rule_with_citation(org_a)

    try:
        await sweep_staleness_refresh_for_org(org_a, [rule])
        assert _mock_pr_flow == []
    finally:
        await _cleanup_org(org_a)


async def test_dedup_prevents_reproposing_the_same_flag_on_a_rerun(
    _test_db_sessionmaker, org_a, _mock_pr_flow, monkeypatch
):
    async def _fake_get_file_content(repo_url, pat, path, ref):
        raise GithubClientError("not found (404)", status_code=404)

    monkeypatch.setattr(tasks_staleness, "get_file_content", _fake_get_file_content)
    await _seed_org_with_github(org_a)
    rule = await _stale_rule_with_citation(org_a)

    try:
        await sweep_staleness_refresh_for_org(org_a, [rule])
        assert len(_mock_pr_flow) == 1

        # A second night's sweep over the same still-unmerged proposal must
        # not open a second PR for the identical (rule, reason, content) --
        # same dedup discipline gnt.contradiction_findings already gives
        # the sibling sweep.
        await sweep_staleness_refresh_for_org(org_a, [rule])
        assert len(_mock_pr_flow) == 1
    finally:
        await _cleanup_org(org_a)


async def test_dedup_allows_a_fresh_proposal_when_the_source_drifts_again(
    _test_db_sessionmaker, org_a, _mock_pr_flow, monkeypatch
):
    """A different content_fingerprint (the source changed a second time
    before anyone reviewed the first proposal) must produce a genuinely
    new row, not get silently absorbed by the first one -- see
    gnt.staleness_refresh's own docstring on why content_fingerprint, not
    just (org_id, rule_slug, reason), is the dedup key."""
    content = {"value": "# Refund policy\n\nRefunds must be processed within 14 days now.\n"}

    async def _fake_get_file_content(repo_url, pat, path, ref):
        return content["value"]

    monkeypatch.setattr(tasks_staleness, "get_file_content", _fake_get_file_content)
    await _seed_org_with_github(org_a)
    rule = await _stale_rule_with_citation(org_a)

    try:
        await sweep_staleness_refresh_for_org(org_a, [rule])
        assert len(_mock_pr_flow) == 1

        content["value"] = "# Refund policy\n\nRefunds must be processed within 7 days now, actually.\n"
        await sweep_staleness_refresh_for_org(org_a, [rule])
        assert len(_mock_pr_flow) == 2
    finally:
        await _cleanup_org(org_a)


async def test_one_rules_failure_does_not_block_the_rest_of_the_orgs_sweep(
    _test_db_sessionmaker, org_a, _mock_pr_flow, monkeypatch
):
    """Mirrors tasks_contradictions.py's own per-pair isolation guarantee:
    a fetch blowing up with something other than the expected
    GithubClientError for one rule must not stop the sweep from still
    proposing a flag for the next one."""
    await _seed_org_with_github(org_a)
    broken_rule = await _stale_rule_with_citation(org_a, "Broken rule")
    healthy_rule = await _stale_rule_with_citation(org_a, "Healthy rule")

    # Both rules point at the same source path in this fixture -- key the
    # blowup off call order instead, so exactly one of the two rules fails
    # with something other than the expected GithubClientError.
    calls = {"count": 0}

    async def _flaky_get_file_content(repo_url, pat, path, ref):
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("unexpected network blowup, not a GithubClientError")
        raise GithubClientError("not found (404)", status_code=404)

    monkeypatch.setattr(tasks_staleness, "get_file_content", _flaky_get_file_content)

    try:
        await sweep_staleness_refresh_for_org(org_a, [broken_rule, healthy_rule])
        # One rule's raw exception must not prevent the other's flag from
        # still getting proposed.
        assert len(_mock_pr_flow) == 1
    finally:
        await _cleanup_org(org_a)


async def test_sweep_staleness_refresh_processes_each_org_in_its_own_scope(
    _test_db_sessionmaker, org_a, org_b, _mock_pr_flow, monkeypatch
):
    """Tenant isolation, same shape test_compute_rule_staleness_processes_
    each_org_in_its_own_scope proves for the passive half: org B's stale
    rule must never get flagged against org A's repo, or vice versa, when
    the real cron entrypoint runs both orgs in one pass."""
    get_cron_engine.cache_clear()
    get_cron_sessionmaker.cache_clear()

    await _seed_org_with_github(org_a, repo_url="https://github.com/acme/rules-a")
    await _seed_org_with_github(org_b, repo_url="https://github.com/acme/rules-b")

    async def _fake_get_file_content(repo_url, pat, path, ref):
        raise GithubClientError("not found (404)", status_code=404)

    monkeypatch.setattr(tasks_staleness, "get_file_content", _fake_get_file_content)

    rule_a = await _stale_rule_with_citation(org_a, "Org A rule")
    rule_b = await _stale_rule_with_citation(org_b, "Org B rule")

    try:
        await compute_rule_staleness({})

        repo_urls = {pr["repo_url"] for pr in _mock_pr_flow}
        assert repo_urls == {"https://github.com/acme/rules-a", "https://github.com/acme/rules-b"}

        async with _test_db_sessionmaker() as session:
            await scope_to_org(session, org_a)
            org_a_rows = (
                await session.execute(
                    select(StalenessRefreshProposal).where(StalenessRefreshProposal.org_id == org_a)
                )
            ).scalars().all()

            await scope_to_org(session, org_b)
            org_b_rows = (
                await session.execute(
                    select(StalenessRefreshProposal).where(StalenessRefreshProposal.org_id == org_b)
                )
            ).scalars().all()

        assert {r.rule_slug for r in org_a_rows} == {rule_a["slug"]}
        assert {r.rule_slug for r in org_b_rows} == {rule_b["slug"]}
    finally:
        await get_cron_engine().dispose()
        get_cron_engine.cache_clear()
        get_cron_sessionmaker.cache_clear()
        await _cleanup_org(org_a)
        await _cleanup_org(org_b)

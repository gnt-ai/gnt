"""sweep_contradictions / sweep_contradictions_for_org / sample_candidate_pairs
— the background job that continuously scans each org's approved rules for
pairs that contradict each other. Mirrors
test_tasks_staleness.py's split: pure sampling logic (_same_tag_pairs,
sample_candidate_pairs) gets direct unit coverage with no DB or network,
while sweep_contradictions_for_org/sweep_contradictions are exercised for
real against a test Postgres + the real store subprocess, with
judge_conflict and the GitHub client mocked at their call boundary (same
mocking shape test_rule_conflict.py and test_github_connection.py already
use for those two dependencies individually).
"""

import inspect
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from gnt.approval import hash_approval_content, sign_approval
from gnt.contradiction_findings import has_been_filed
from gnt.db.models import ContradictionFinding, GithubConnection, OnboardingEvent, Org
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.db.session import get_cron_engine, get_cron_sessionmaker
from gnt.github.client import IssueResult, PullRequestResult
from gnt.github.crypto import encrypt_token
from gnt.github.render import parse_rule_markdown
from gnt.pipeline.rule_schemas import RuleMergeVerdict
from gnt.store_client import StoreClientError
from gnt.store_client import get_rule as store_get_rule
from gnt.store_client import list_rules as store_list_rules
from gnt.store_client import put_rule
from gnt.workers import tasks_contradictions
from gnt.workers.tasks_contradictions import (
    _same_tag_pairs,
    sample_candidate_pairs,
    sweep_contradictions,
    sweep_contradictions_for_org,
)
from tests.conftest import TEST_DATABASE_URL

REPO_URL = "https://github.com/acme/rules"


def _rule(slug: str, title: str, tags: list[str] | None = None, body: str = "body") -> dict:
    return {"slug": slug, "title": title, "body": body, "tags": tags or []}


# --- _same_tag_pairs: pure, no DB/network -----------------------------


def test_same_tag_pairs_groups_by_shared_tag():
    a = _rule("rules/a", "A", tags=["refunds"])
    b = _rule("rules/b", "B", tags=["refunds"])
    c = _rule("rules/c", "C", tags=["shipping"])

    pairs = _same_tag_pairs([a, b, c], max_pairs=10)

    assert len(pairs) == 1
    assert {pairs[0][0]["slug"], pairs[0][1]["slug"]} == {"rules/a", "rules/b"}


def test_same_tag_pairs_dedupes_a_pair_sharing_multiple_tags():
    a = _rule("rules/a", "A", tags=["refunds", "billing"])
    b = _rule("rules/b", "B", tags=["refunds", "billing"])

    pairs = _same_tag_pairs([a, b], max_pairs=10)

    assert len(pairs) == 1


def test_same_tag_pairs_respects_max_pairs():
    rules = [_rule(f"rules/{i}", f"R{i}", tags=["shared"]) for i in range(5)]

    pairs = _same_tag_pairs(rules, max_pairs=2)

    assert len(pairs) == 2


def test_same_tag_pairs_ignores_untagged_rules():
    a = _rule("rules/a", "A", tags=[])
    b = _rule("rules/b", "B", tags=[])

    assert _same_tag_pairs([a, b], max_pairs=10) == []


# --- sample_candidate_pairs: same-tag first, then search fallback -----


async def test_sample_candidate_pairs_uses_same_tag_when_available(monkeypatch):
    async def _fail_if_called(org_id, query):
        raise AssertionError("search_rules should not run when same-tag pairing already fills the budget")

    monkeypatch.setattr("gnt.workers.tasks_contradictions.search_rules", _fail_if_called)

    a = _rule("rules/a", "A", tags=["refunds"])
    b = _rule("rules/b", "B", tags=["refunds"])

    pairs = await sample_candidate_pairs("org_a", [a, b], max_pairs=5)
    assert len(pairs) == 1


async def test_sample_candidate_pairs_falls_back_to_search_for_untagged_rules(monkeypatch):
    a = _rule("rules/a", "A", tags=[])
    b = _rule("rules/b", "B", tags=[])

    async def _fake_search(org_id, query):
        return [{"slug": "rules/b", "title": "B", "body": "body"}]

    monkeypatch.setattr("gnt.workers.tasks_contradictions.search_rules", _fake_search)

    pairs = await sample_candidate_pairs("org_a", [a, b], max_pairs=5)
    assert len(pairs) == 1
    assert {pairs[0][0]["slug"], pairs[0][1]["slug"]} == {"rules/a", "rules/b"}


async def test_sample_candidate_pairs_search_failure_skips_that_rule(monkeypatch):
    a = _rule("rules/a", "A", tags=[])
    b = _rule("rules/b", "B", tags=[])

    async def _fake_search(org_id, query):
        raise StoreClientError("store unreachable")

    monkeypatch.setattr("gnt.workers.tasks_contradictions.search_rules", _fake_search)

    pairs = await sample_candidate_pairs("org_a", [a, b], max_pairs=5)
    assert pairs == []


# --- sweep_contradictions_for_org: the real entrypoint -----------------


@pytest.fixture
def org_a() -> str:
    # Fresh per test, not conftest's shared "org_test_a" -- the store
    # subprocess persists approved rules for the whole test session (same
    # reasoning test_tasks_staleness.py's own org_a/org_b override gives).
    return f"org_test_contradictions_{uuid.uuid4().hex[:8]}"


@pytest.fixture
def org_b() -> str:
    return f"org_test_contradictions_{uuid.uuid4().hex[:8]}"


@pytest.fixture
async def _test_db_sessionmaker(monkeypatch):
    engine = create_async_engine(TEST_DATABASE_URL)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(tasks_contradictions, "get_sessionmaker", lambda: session_factory)
    # Every sweep test below is exercising the sampling/budget/dedup
    # logic, not the per-org LLM spend quota gate (the budget check that
    # runs before each real judge_conflict call) — that gate has its own
    # dedicated coverage in tests/test_llm_quota.py, so stub it to always
    # allow here rather than in each test individually.
    # test_sweep_stops_early_when_llm_quota_is_exhausted below overrides
    # check_llm_quota specifically to prove the sweep actually wires into
    # it.
    async def _ok(org_id, **kwargs):
        return True

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(tasks_contradictions, "check_llm_quota", _ok)
    monkeypatch.setattr(tasks_contradictions, "record_llm_usage", _noop)
    yield session_factory
    await engine.dispose()


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


async def _seed_org_without_github(org_id: str) -> None:
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
            await session.execute(
                ContradictionFinding.__table__.delete().where(ContradictionFinding.org_id == org_id)
            )
            await session.execute(GithubConnection.__table__.delete().where(GithubConnection.org_id == org_id))
            # The sweep's own proposed-resolution PR now
            # logs a "rule_proposed" onboarding event (routers/rules.py's
            # propose_rule_for_org, reused verbatim by the sweep) for any
            # test that actually gets that far; orgs.id's FK from
            # onboarding_events would otherwise block the delete below.
            await session.execute(OnboardingEvent.__table__.delete().where(OnboardingEvent.org_id == org_id))
            org = (await session.execute(select(Org).where(Org.id == org_id))).scalar_one_or_none()
            if org is not None:
                await session.delete(org)
            await session.commit()
    finally:
        await engine.dispose()


async def _approved_rule(
    org_id: str,
    title: str,
    *,
    tags: list[str] | None = None,
    body: str = "body",
    approved_at: str = "2026-01-01T00:00:00Z",
) -> dict:
    slug = f"rules/{uuid.uuid4()}"
    rule = {
        "slug": slug,
        "org": org_id,
        "title": title,
        "body": body,
        "status": "approved",
        "confidence": 0.7,
        "ownerId": "test_user",
        "sourceCitations": [],
        "tags": tags or [],
        "lastValidatedAt": None,
        "version": 1,
        "supersededBy": None,
        "previousVersionId": None,
        "approvedBy": "admin_a",
        # Overridable — _order_by_approval picks which of
        # a contradicting pair gets amended by approvedAt, so tests
        # exercising that pick need two rules seeded with two different
        # timestamps, not both defaulting to the same one.
        "approvedAt": approved_at,
        "createdAt": approved_at,
        "prNumber": None,
        "prUrl": None,
    }
    # Mirrors test_tasks_staleness.py's _approve_directly_via_store --
    # there's no HTTP path to "approved" anymore, so this satisfies the
    # store's approval-signing gate directly, the same shortcut that and
    # test_rules.py/test_mcp_tools.py already use.
    content_hash = hash_approval_content(title=title, body=body, tags=rule["tags"], status="approved")
    signature = sign_approval(org_id=org_id, slug=slug, version=1, content_hash=content_hash)
    await put_rule(rule, approval_signature=signature)
    return rule


@pytest.fixture
def _mock_judge(monkeypatch):
    """Returns a setter the test calls with the relation the mocked
    judge_conflict should report for every pair it's asked about."""
    verdicts: dict[str, str] = {"relation": "contradicts", "explanation": "conflicting windows"}

    def _judge_conflict(existing_title, existing_body, new_title, new_body):
        # judge_conflict returns (verdict, input_tokens, output_tokens) —
        # see its own docstring on why: those token counts feed the
        # per-org LLM spend quota's usage tracking, so every real call
        # site has to report them back after judging a pair.
        return RuleMergeVerdict(relation=verdicts["relation"], explanation=verdicts["explanation"]), 100, 25

    monkeypatch.setattr("gnt.workers.tasks_contradictions.judge_conflict", _judge_conflict)
    return verdicts


@pytest.fixture
def _mock_create_issue(monkeypatch):
    calls: list[dict] = []

    async def _create_issue(repo_url, pat, title, body):
        calls.append({"repo_url": repo_url, "pat": pat, "title": title, "body": body})
        return IssueResult(number=len(calls), url=f"https://github.com/acme/rules/issues/{len(calls)}")

    monkeypatch.setattr("gnt.workers.tasks_contradictions.create_issue", _create_issue)
    return calls


@pytest.fixture
def _mock_propose_pr(monkeypatch):
    """The proposed-resolution PR the sweep now opens
    alongside the issue rides through routers/rules.py's propose_rule_for_org
    (reused verbatim, not reimplemented here — see workers/
    tasks_contradictions.py's module docstring), which is what actually
    calls create_branch/put_file/open_pull_request/find_conflict. Mocked at
    that same call boundary test_rules.py's own propose_rule tests already
    use (gnt.routers.rules.*, not gnt.workers.tasks_contradictions.*) —
    find_conflict is stubbed to "no conflict" so this doesn't also fire a
    second, real LLM comparison against the very rules the sweep is
    already judging."""
    calls: list[dict] = []

    async def _fake_create_branch(repo_url, pat, branch, base_branch):
        calls.append({"step": "create_branch", "repo_url": repo_url, "branch": branch, "base_branch": base_branch})

    async def _fake_put_file(repo_url, pat, branch, path, content, message):
        calls.append({"step": "put_file", "repo_url": repo_url, "branch": branch, "path": path, "content": content})

    async def _fake_open_pull_request(repo_url, pat, head_branch, base_branch, title, body):
        pr_number = 1 + sum(1 for c in calls if c["step"] == "open_pull_request")
        calls.append(
            {
                "step": "open_pull_request",
                "repo_url": repo_url,
                "head_branch": head_branch,
                "title": title,
                "body": body,
                "pr_number": pr_number,
            }
        )
        return PullRequestResult(number=pr_number, url=f"https://github.com/acme/rules/pull/{pr_number}")

    async def _fake_find_conflict(org_id, rule):
        return None

    monkeypatch.setattr("gnt.routers.rules.create_branch", _fake_create_branch)
    monkeypatch.setattr("gnt.routers.rules.put_file", _fake_put_file)
    monkeypatch.setattr("gnt.routers.rules.open_pull_request", _fake_open_pull_request)
    monkeypatch.setattr("gnt.routers.rules.find_conflict", _fake_find_conflict)
    return calls


async def test_sweep_skips_org_with_no_github_connection(_test_db_sessionmaker, org_a, _mock_judge, _mock_create_issue):
    await _seed_org_without_github(org_a)
    try:
        await sweep_contradictions_for_org(org_a)
        assert _mock_create_issue == []
    finally:
        await _cleanup_org(org_a)


async def test_sweep_files_an_issue_for_a_contradicting_pair(
    _test_db_sessionmaker, org_a, _mock_judge, _mock_create_issue, _mock_propose_pr
):
    await _seed_org_with_github(org_a)
    rule_a = await _approved_rule(org_a, "Refund window is 30 days", tags=["refunds"])
    rule_b = await _approved_rule(org_a, "Refund window is 45 days", tags=["refunds"])

    try:
        await sweep_contradictions_for_org(org_a)

        assert len(_mock_create_issue) == 1
        assert _mock_create_issue[0]["repo_url"] == REPO_URL

        async with _test_db_sessionmaker() as session:
            filed = await has_been_filed(session, org_a, rule_a["slug"], rule_b["slug"])
        assert filed is True
    finally:
        await _cleanup_org(org_a)


async def test_sweep_opens_a_proposed_resolution_pr_with_a_genuinely_amended_body(
    _test_db_sessionmaker, org_a, _mock_judge, _mock_create_issue, _mock_propose_pr
):
    """A confirmed contradiction gets a real PR proposing
    one concrete resolution, not just the bare issue report. Asserts on
    the actual rendered file content routers/rules.py's propose_rule_for_org
    writes via put_file, not just "a PR opened": the older rule's own body
    text must still be present verbatim, plus the appended note pointing
    at the newer rule by title and slug — this is a scoped amendment, not
    a rewrite."""
    await _seed_org_with_github(org_a)
    older = await _approved_rule(
        org_a, "Refund window is 30 days", tags=["refunds"], body="Refunds within 30 days.",
        approved_at="2026-01-01T00:00:00Z",
    )
    newer = await _approved_rule(
        org_a, "Refund window is 45 days", tags=["refunds"], body="Refunds within 45 days.",
        approved_at="2026-02-01T00:00:00Z",
    )

    try:
        await sweep_contradictions_for_org(org_a)

        pr_calls = [c for c in _mock_propose_pr if c["step"] == "open_pull_request"]
        assert len(pr_calls) == 1
        assert pr_calls[0]["title"] == f"Resolve contradiction: {older['title']}"

        put_file_calls = [c for c in _mock_propose_pr if c["step"] == "put_file"]
        assert len(put_file_calls) == 1
        frontmatter, body = parse_rule_markdown(put_file_calls[0]["content"])

        # The older rule's own body survives untouched, plus the appended
        # deference note naming the newer rule.
        assert body.startswith("Refunds within 30 days.")
        assert "may be superseded by" in body
        assert newer["title"] in body
        assert newer["slug"] in body
        # The newer rule's own body is never pulled into this file at all.
        assert "Refunds within 45 days." not in body

        # frontmatter carries the amendment's own version-chain fields —
        # see the dedicated version/previousVersionId test below for the
        # full assertion on those.
        assert frontmatter["status"] == "pending_merge"
    finally:
        await _cleanup_org(org_a)


async def test_sweep_proposed_amendment_carries_previous_version_id_and_bumped_version(
    _test_db_sessionmaker, org_a, _mock_judge, _mock_create_issue, _mock_propose_pr
):
    """The amendment draft the sweep creates (routers/rules.py's
    create_rule_amendment, triggered from _propose_resolution) must carry
    previousVersionId/version exactly the way a human's POST /edit would —
    that's what lets the existing merge webhook (routers/github_webhook.py)
    correctly supersede the older rule if a human merges this PR, with no
    new supersede logic of its own."""
    await _seed_org_with_github(org_a)
    older = await _approved_rule(
        org_a, "Refund window is 30 days", tags=["refunds"], approved_at="2026-01-01T00:00:00Z"
    )
    await _approved_rule(org_a, "Refund window is 45 days", tags=["refunds"], approved_at="2026-02-01T00:00:00Z")

    try:
        await sweep_contradictions_for_org(org_a)

        drafts = await store_list_rules(org_a, status="pending_merge")
        assert len(drafts) == 1
        draft = drafts[0]
        assert draft["previousVersionId"] == older["slug"]
        assert draft["version"] == older["version"] + 1
        assert draft["title"] == older["title"]

        # The older rule itself is completely untouched — only the new
        # draft row moved, exactly the "rule_a/rule_b never get written
        # directly" guarantee the module docstring describes.
        untouched = await store_get_rule(org_a, older["slug"])
        assert untouched["status"] == "approved"
        assert untouched["body"] == older["body"]
    finally:
        await _cleanup_org(org_a)


async def test_sweep_never_files_for_a_distinct_relation(
    _test_db_sessionmaker, org_a, _mock_judge, _mock_create_issue
):
    _mock_judge["relation"] = "distinct"
    await _seed_org_with_github(org_a)
    await _approved_rule(org_a, "Refund policy", tags=["refunds"])
    await _approved_rule(org_a, "Shipping policy", tags=["refunds"])

    try:
        await sweep_contradictions_for_org(org_a)
        assert _mock_create_issue == []
    finally:
        await _cleanup_org(org_a)


async def test_sweep_never_files_twice_for_the_same_pair(
    _test_db_sessionmaker, org_a, _mock_judge, _mock_create_issue, _mock_propose_pr
):
    await _seed_org_with_github(org_a)
    await _approved_rule(org_a, "Refund window is 30 days", tags=["refunds"], approved_at="2026-01-01T00:00:00Z")
    await _approved_rule(org_a, "Refund window is 45 days", tags=["refunds"], approved_at="2026-02-01T00:00:00Z")

    try:
        await sweep_contradictions_for_org(org_a)
        assert len(_mock_create_issue) == 1
        assert len([c for c in _mock_propose_pr if c["step"] == "open_pull_request"]) == 1

        # A second run of the same night's (or a later night's) sweep
        # over an unresolved finding must not spend another judge_conflict
        # call, open a second issue, or propose a second resolution PR for
        # the identical pair — has_been_filed's dedup
        # gate short-circuits _process_pair before either GitHub call ever
        # runs again.
        await sweep_contradictions_for_org(org_a)
        assert len(_mock_create_issue) == 1
        assert len([c for c in _mock_propose_pr if c["step"] == "open_pull_request"]) == 1
    finally:
        await _cleanup_org(org_a)


async def test_sweep_respects_the_issues_per_org_budget(
    _test_db_sessionmaker, org_a, _mock_judge, _mock_create_issue, _mock_propose_pr, monkeypatch
):
    from gnt.config import get_settings

    # get_settings() is lru_cache'd, so this mutates the one shared
    # singleton instance -- monkeypatch.setattr on that instance's
    # attribute (not the module-level function) restores it at teardown
    # regardless of the cache.
    monkeypatch.setattr(get_settings(), "contradiction_sweep_max_issues_per_org", 1)

    await _seed_org_with_github(org_a)
    # Three same-tagged rules -> three same-tag pairs, all judged
    # "contradicts" by the mock -- only 1 may actually get filed.
    await _approved_rule(org_a, "Rule one", tags=["refunds"])
    await _approved_rule(org_a, "Rule two", tags=["refunds"])
    await _approved_rule(org_a, "Rule three", tags=["refunds"])

    try:
        await sweep_contradictions_for_org(org_a)
        assert len(_mock_create_issue) == 1
    finally:
        await _cleanup_org(org_a)


async def test_sweep_respects_the_comparisons_per_org_budget(
    _test_db_sessionmaker, org_a, _mock_create_issue, monkeypatch
):
    from gnt.config import get_settings

    comparisons_made = {"count": 0}

    def _counting_judge(existing_title, existing_body, new_title, new_body):
        comparisons_made["count"] += 1
        return RuleMergeVerdict(relation="distinct", explanation="unrelated"), 90, 15

    monkeypatch.setattr("gnt.workers.tasks_contradictions.judge_conflict", _counting_judge)
    monkeypatch.setattr(get_settings(), "contradiction_sweep_max_comparisons_per_org", 1)

    await _seed_org_with_github(org_a)
    await _approved_rule(org_a, "Rule one", tags=["refunds"])
    await _approved_rule(org_a, "Rule two", tags=["refunds"])
    await _approved_rule(org_a, "Rule three", tags=["refunds"])

    try:
        await sweep_contradictions_for_org(org_a)
        assert comparisons_made["count"] == 1
    finally:
        await _cleanup_org(org_a)


async def test_sweep_stops_early_when_llm_quota_is_exhausted(
    _test_db_sessionmaker, org_a, _mock_create_issue, monkeypatch
):
    """The per-org sweep checks check_llm_quota (the per-org LLM spend
    quota gate, which caps how much a plan can spend on real judge calls)
    before every judge_conflict call, same quiet-break shape as the
    existing comparisons/issues budget checks right above it in the loop.
    Once the quota's gone, the loop stops immediately: no further
    judge_conflict calls, no issues filed from pairs that were still
    queued."""
    comparisons_made = {"count": 0}

    def _counting_judge(existing_title, existing_body, new_title, new_body):
        comparisons_made["count"] += 1
        return RuleMergeVerdict(relation="contradicts", explanation="conflicting windows"), 100, 25

    async def _exhausted(org_id, **kwargs):
        return False

    monkeypatch.setattr(tasks_contradictions, "judge_conflict", _counting_judge)
    monkeypatch.setattr(tasks_contradictions, "check_llm_quota", _exhausted)

    await _seed_org_with_github(org_a)
    await _approved_rule(org_a, "Rule one", tags=["refunds"])
    await _approved_rule(org_a, "Rule two", tags=["refunds"])
    await _approved_rule(org_a, "Rule three", tags=["refunds"])

    try:
        await sweep_contradictions_for_org(org_a)
        assert comparisons_made["count"] == 0
        assert _mock_create_issue == []
    finally:
        await _cleanup_org(org_a)


async def test_sweep_contradictions_processes_each_org_in_its_own_scope(
    _test_db_sessionmaker, org_a, org_b, _mock_judge, _mock_create_issue, _mock_propose_pr
):
    """The cron entrypoint's own tenant-isolation guarantee, same shape
    test_tasks_staleness.py proves for compute_rule_staleness: org B's
    rules must never end up compared against org A's, or vice versa. Also
    covers the proposed-resolution flow's own tenant-isolation surface: the
    proposed-resolution PR/draft each org's sweep opens must stay scoped
    to that org's own repo and rules, never leak into the other org."""
    get_cron_engine.cache_clear()
    get_cron_sessionmaker.cache_clear()

    await _seed_org_with_github(org_a, repo_url="https://github.com/acme/rules-a")
    await _seed_org_with_github(org_b, repo_url="https://github.com/acme/rules-b")
    await _approved_rule(org_a, "Org A rule one", tags=["shared"], approved_at="2026-01-01T00:00:00Z")
    await _approved_rule(org_a, "Org A rule two", tags=["shared"], approved_at="2026-02-01T00:00:00Z")
    await _approved_rule(org_b, "Org B rule one", tags=["shared"], approved_at="2026-01-01T00:00:00Z")
    await _approved_rule(org_b, "Org B rule two", tags=["shared"], approved_at="2026-02-01T00:00:00Z")

    try:
        await sweep_contradictions({})

        repo_urls = {call["repo_url"] for call in _mock_create_issue}
        assert repo_urls == {"https://github.com/acme/rules-a", "https://github.com/acme/rules-b"}

        pr_repo_urls = {c["repo_url"] for c in _mock_propose_pr if c["step"] == "open_pull_request"}
        assert pr_repo_urls == {"https://github.com/acme/rules-a", "https://github.com/acme/rules-b"}

        # Each org's proposed-resolution draft is only visible under its
        # own org_id — if the sweep's per-org scope_to_org'd session (see
        # module docstring) ever leaked, one org's draft would show up
        # under the other's store_list_rules call instead of its own.
        drafts_a = await store_list_rules(org_a, status="pending_merge")
        drafts_b = await store_list_rules(org_b, status="pending_merge")
        assert len(drafts_a) == 1
        assert len(drafts_b) == 1
        assert drafts_a[0]["title"].startswith("Org A")
        assert drafts_b[0]["title"].startswith("Org B")
    finally:
        await get_cron_engine().dispose()
        get_cron_engine.cache_clear()
        get_cron_sessionmaker.cache_clear()
        await _cleanup_org(org_a)
        await _cleanup_org(org_b)


async def test_sweep_one_failed_resolution_pr_does_not_block_the_rest_of_the_batch(
    _test_db_sessionmaker, org_a, _mock_judge, _mock_create_issue, _mock_propose_pr, monkeypatch
):
    """_propose_resolution's own best-effort discipline,
    one level inside _process_pair's existing "one bad candidate never
    derails the rest of the run" guarantee (see both functions'
    docstrings). Every proposed-resolution PR attempt in this run fails
    (create_branch always raises) -- the issue for each pair must still
    get filed regardless, and the failure on pair one must not stop pair
    two from being judged and filed in the same sweep."""

    async def _boom(*args, **kwargs):
        raise RuntimeError("github is down")

    monkeypatch.setattr("gnt.routers.rules.create_branch", _boom)

    await _seed_org_with_github(org_a)
    # Two same-tag pairs -- both judged "contradicts" by _mock_judge.
    await _approved_rule(org_a, "Rule one", tags=["refunds"], approved_at="2026-01-01T00:00:00Z")
    await _approved_rule(org_a, "Rule two", tags=["refunds"], approved_at="2026-02-01T00:00:00Z")
    await _approved_rule(org_a, "Rule three", tags=["billing"], approved_at="2026-01-01T00:00:00Z")
    await _approved_rule(org_a, "Rule four", tags=["billing"], approved_at="2026-02-01T00:00:00Z")

    try:
        await sweep_contradictions_for_org(org_a)

        # Both pairs still got their issue filed even though every PR
        # attempt blew up -- the failure never propagated up into
        # _process_pair's own dedup/issue-filing for either pair.
        assert len(_mock_create_issue) == 2
        # And no PR silently "succeeded" via the fixture's own working
        # fakes -- create_branch raising means open_pull_request is never
        # even reached.
        assert [c for c in _mock_propose_pr if c["step"] == "open_pull_request"] == []
    finally:
        await _cleanup_org(org_a)


# --- structural guarantee: never touches a rule's status ---------------


def test_module_never_imports_or_calls_anything_that_writes_a_rules_status():
    """Hard constraint on the sweep: it only ever files a
    finding for a human, it must never change a rule's status itself.
    Checked against the module's actual imports and call sites via ast,
    not a plain substring scan of the source (which would also flag this
    docstring's own explanation of the constraint) -- so a future edit
    that adds a real status-writing call here fails a test, not just a
    review."""
    import ast

    tree = ast.parse(inspect.getsource(tasks_contradictions))
    banned_names = {"put_rule", "deprecate_rule", "approve_rule"}

    imported_names = {
        alias.asname or alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom)
        for alias in node.names
    }
    assert imported_names.isdisjoint(banned_names), imported_names & banned_names

    called_names = {
        node.func.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    assert called_names.isdisjoint(banned_names), called_names & banned_names

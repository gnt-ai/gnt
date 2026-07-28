"""Direct-call tests of the MCP tool functions — same pattern
eval/refund_triage/run_eval.py already uses (set the contextvars a real
MCP request would carry, call the tool function directly). This is not
a full end-to-end test through the real MCP protocol/transport — that
gap is called out in the PR description rather than silently assumed
covered. What these tests DO verify for real: approved-only filtering,
cross-org isolation, tag filtering, and the sliding-window rate limit,
against the REAL apps/store server (see conftest.py's session-scoped
_store_server fixture) with a fake, deterministic (but non-semantic)
embedding — same discipline apps/store's own bun:test suite applies
(Global Rule 6 — no real embedding API calls from a test loop).

search_rules/get_rule read real approved rules from apps/store's
git-native engine via store_client.py, not a local Postgres table — see
mcp_server/server.py's own comment on why. There is no HTTP path to
"approved" (a human merging a real GitHub PR is the only production
path, confirmed by the webhook handler) — _approve_directly_via_store
below signs and writes it the same way that webhook does, mirroring
test_rules.py's identically-named helper rather than importing a
private helper across test files.
"""

import uuid
from datetime import datetime, timezone

import pytest
import redis.exceptions
from sqlalchemy import select

from gnt import rate_limit
from gnt.db.models import RoiCounter, RuleGap
from gnt.db.org import ensure_org
from gnt.mcp_server import server as mcp_server
from gnt.mcp_server.context import current_key_id, current_org_id
from gnt.store_client import put_rule


@pytest.fixture(autouse=True)
def _no_llm_quota_gate(monkeypatch):
    """C9a wires a real Postgres-backed LLM spend quota gate into
    evaluate_action (gnt.llm_quota), and the plan's monthly check_action
    cap (gnt.plan_limits) is the same shape — both have their own
    dedicated coverage (tests/test_llm_quota.py, tests/test_plan_limits.py).
    None of these check_action tests are testing either gate (they're
    testing MCP-tool wiring, tenant isolation, gap/ROI bumping), so stub
    both out here rather than per-test, the same shape
    tests/test_check_action.py and tests/test_rule_conflict.py use."""

    async def _ok(*args, **kwargs):
        return None

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr("gnt.action_check.enforce_llm_quota", _ok)
    monkeypatch.setattr("gnt.action_check.enforce_plan_action_cap", _ok)
    monkeypatch.setattr("gnt.action_check.record_llm_usage", _noop)


def _rule_dict(org_id: str, slug: str, title: str, tags: list[str] | None = None) -> dict:
    return {
        "slug": slug,
        "org": org_id,
        "title": title,
        "body": f"body for {title}",
        "status": "draft",
        "confidence": 0.7,
        "ownerId": "test_user",
        "sourceCitations": [],
        "tags": tags or [],
        "lastValidatedAt": None,
        "version": 1,
        "supersededBy": None,
        "previousVersionId": None,
        "approvedBy": None,
        "approvedAt": None,
        "createdAt": "2026-07-14T00:00:00Z",
        "prNumber": None,
        "prUrl": None,
    }


async def _approve_directly_via_store(org_id: str, rule: dict) -> dict:
    from gnt.approval import hash_approval_content, sign_approval

    rule = dict(rule)
    rule["status"] = "approved"
    rule["approvedBy"] = "admin_a"
    rule["approvedAt"] = "2026-07-14T00:00:00Z"
    content_hash = hash_approval_content(
        title=rule["title"], body=rule["body"], tags=rule["tags"], status=rule["status"]
    )
    signature = sign_approval(
        org_id=org_id, slug=rule["slug"], version=rule["version"], content_hash=content_hash
    )
    await put_rule(rule, approval_signature=signature)
    return rule


@pytest.fixture
async def seeded_org(monkeypatch):
    from gnt.config import get_settings as real_get_settings

    # The fake embedding is a deterministic hash of the text, not a
    # semantically meaningful vector (see apps/store/src/testing/fake-embed.ts)
    # — cosine similarity against it lands anywhere in the full [-1, 1]
    # range, including negative, for genuinely unrelated random vectors
    # (confirmed empirically: a real approved rule scored -0.03 against
    # "refund" here). A 0.0 threshold still filters those out — only -1.0
    # (cosine similarity's actual floor) guarantees the fake vector arm
    # never excludes anything by relevance.
    #
    # gnt-fix-plan-v2 item 11: search() runs the vendored engine's hybrid
    # retrieval now, which has a real keyword/BM25 arm on top of vector --
    # with no embedding provider configured in this test process (Global
    # Rule 6), hybridSearch runs keyword-only, and Postgres full-text
    # search genuinely filters by term overlap regardless of this
    # threshold. Below, queries are chosen to lexically match the rules
    # each test expects back (a real BM25 arm doesn't have a permissive
    # floor the way the old fakeEmbed vector arm did) -- status/tag
    # filtering is still what's actually under test.
    no_threshold_settings = real_get_settings().model_copy(
        update={"search_rules_similarity_threshold": -1.0}
    )
    monkeypatch.setattr(mcp_server, "get_settings", lambda: no_threshold_settings)

    org_id = f"__mcp_test_{uuid.uuid4().hex[:8]}__"

    # Real ids are str(uuid.uuid4()) (see routers/rules.py's create_rule) —
    # get_rule validates the id looks like one before ever asking the
    # store, so a slug like "rules/mcp-approved" would always 404 there
    # regardless of what's actually stored.
    def slug() -> str:
        return f"rules/{uuid.uuid4()}"

    approved = await _approve_directly_via_store(
        org_id, _rule_dict(org_id, slug(), "Refund window", tags=["refunds", "policy"])
    )

    draft = _rule_dict(org_id, slug(), "Draft rule — should never be servable")
    await put_rule(draft)

    in_review = _rule_dict(org_id, slug(), "In-review rule — should never be servable")
    in_review["status"] = "in_review"
    await put_rule(in_review)

    deprecated = await _approve_directly_via_store(
        org_id, _rule_dict(org_id, slug(), "Deprecated rule — should never be servable")
    )
    deprecated["status"] = "deprecated"
    await put_rule(deprecated)

    other_tag_approved = await _approve_directly_via_store(
        org_id, _rule_dict(org_id, slug(), "Shipping window", tags=["shipping"])
    )

    return {
        "org_id": org_id,
        "approved": approved,
        "draft": draft,
        "in_review": in_review,
        "deprecated": deprecated,
        "other_tag_approved": other_tag_approved,
    }


def _bare_id(rule: dict) -> str:
    return rule["slug"].removeprefix("rules/")


def _set_context(org_id: str, key_id: str = "test_key"):
    org_token = current_org_id.set(org_id)
    key_token = current_key_id.set(key_id)
    return org_token, key_token


def _reset_context(tokens):
    org_token, key_token = tokens
    current_org_id.reset(org_token)
    current_key_id.reset(key_token)


async def test_search_rules_only_returns_approved(seeded_org):
    tokens = _set_context(seeded_org["org_id"])
    try:
        # "window" lexically matches both approved rules' bodies ("body for
        # Refund window" / "body for Shipping window") -- see seeded_org's
        # comment on why the query has to actually be relevant now.
        hits = await mcp_server.search_rules(query="window")
    finally:
        _reset_context(tokens)

    ids = {h["id"] for h in hits}
    assert _bare_id(seeded_org["approved"]) in ids
    assert _bare_id(seeded_org["other_tag_approved"]) in ids
    assert _bare_id(seeded_org["draft"]) not in ids
    assert _bare_id(seeded_org["in_review"]) not in ids
    assert _bare_id(seeded_org["deprecated"]) not in ids


async def test_search_rules_includes_provenance_footer(seeded_org):
    tokens = _set_context(seeded_org["org_id"])
    try:
        hits = await mcp_server.search_rules(query="refund")
    finally:
        _reset_context(tokens)

    hit = next(h for h in hits if h["id"] == _bare_id(seeded_org["approved"]))
    assert hit["provenance"]["approved_by"] == "admin_a"
    assert hit["provenance"]["approved_at"] == "2026-07-14T00:00:00Z"


async def test_search_rules_includes_freshness_estimate(seeded_org):
    """fix-plan-v2 item 9 — every rule response carries an age/freshness
    estimate, explicitly labeled as such (item 18), computed live off the
    rule's own approvedAt rather than a value read back from a nightly
    snapshot that could be stale itself."""
    tokens = _set_context(seeded_org["org_id"])
    try:
        hits = await mcp_server.search_rules(query="refund")
    finally:
        _reset_context(tokens)

    hit = next(h for h in hits if h["id"] == _bare_id(seeded_org["approved"]))
    freshness = hit["freshness"]
    assert freshness["estimate"] is True
    assert freshness["basis"] == "approved_at"
    assert freshness["age_days"] > 0
    assert 0.0 < freshness["freshness_score"] <= 1.0


async def test_search_rules_labels_confidence_as_an_estimate(seeded_org):
    """fix-plan-v2 item 18 — confidence is a model-assigned score set once
    at creation time, never independently verified; every rule response
    says so explicitly, same convention as freshness's own estimate flag."""
    tokens = _set_context(seeded_org["org_id"])
    try:
        hits = await mcp_server.search_rules(query="refund")
    finally:
        _reset_context(tokens)

    hit = next(h for h in hits if h["id"] == _bare_id(seeded_org["approved"]))
    assert hit["confidence_estimate"] is True


async def test_search_rules_tag_filter(seeded_org):
    tokens = _set_context(seeded_org["org_id"])
    try:
        # "window" matches both approved rules lexically (see seeded_org's
        # comment) -- the tags filter below is what's actually under test.
        hits = await mcp_server.search_rules(query="window", tags=["shipping"])
    finally:
        _reset_context(tokens)

    ids = {h["id"] for h in hits}
    assert _bare_id(seeded_org["other_tag_approved"]) in ids
    assert _bare_id(seeded_org["approved"]) not in ids


async def test_get_rule_returns_approved_rule(seeded_org):
    tokens = _set_context(seeded_org["org_id"])
    try:
        result = await mcp_server.get_rule(_bare_id(seeded_org["approved"]))
    finally:
        _reset_context(tokens)

    assert result["id"] == _bare_id(seeded_org["approved"])
    assert result["title"] == "Refund window"
    assert result["provenance"]["approved_by"] == "admin_a"
    assert result["freshness"]["estimate"] is True
    assert "similarity" not in result


async def test_get_rule_accepts_deprecated_id_alias(seeded_org):
    """Pre-rename callers still sending `id` instead of `rule_id` must keep
    working, not just get a warning — see get_rule's own docstring."""
    tokens = _set_context(seeded_org["org_id"])
    try:
        result = await mcp_server.get_rule(id=_bare_id(seeded_org["approved"]))
    finally:
        _reset_context(tokens)

    assert result["id"] == _bare_id(seeded_org["approved"])


async def test_get_rule_prefers_rule_id_when_both_aliases_given(seeded_org):
    tokens = _set_context(seeded_org["org_id"])
    try:
        result = await mcp_server.get_rule(
            rule_id=_bare_id(seeded_org["approved"]), id=_bare_id(seeded_org["other_tag_approved"])
        )
    finally:
        _reset_context(tokens)

    assert result["id"] == _bare_id(seeded_org["approved"])


async def test_get_rule_refuses_non_approved(seeded_org):
    tokens = _set_context(seeded_org["org_id"])
    try:
        with pytest.raises(RuntimeError, match="no approved rule"):
            await mcp_server.get_rule(_bare_id(seeded_org["draft"]))
    finally:
        _reset_context(tokens)


async def test_get_rule_cross_tenant_is_refused(seeded_org):
    other_org_tokens = _set_context("__mcp_test_other_org__")
    try:
        with pytest.raises(RuntimeError, match="no approved rule"):
            await mcp_server.get_rule(_bare_id(seeded_org["approved"]))
    finally:
        _reset_context(other_org_tokens)


async def test_search_rules_never_returns_draft_across_orgs(seeded_org):
    """Same check as the cross-tenant REST test, at the MCP layer."""
    tokens = _set_context("__mcp_test_other_org__")
    try:
        hits = await mcp_server.search_rules(query="refund")
    finally:
        _reset_context(tokens)
    assert hits == []


async def test_mcp_rate_limit_enforced_per_key(seeded_org, monkeypatch):
    from gnt.config import get_settings as real_get_settings

    limited_settings = real_get_settings().model_copy(
        update={"mcp_rate_limit_per_key": 2, "search_rules_similarity_threshold": -1.0}
    )
    monkeypatch.setattr(mcp_server, "get_settings", lambda: limited_settings)

    # Unique per test run — the sliding-window counter lives in real Redis
    # with no per-test cleanup, so a fixed key would pick up leftover
    # entries from a previous run of this same test and trip early.
    tokens = _set_context(seeded_org["org_id"], key_id=f"rate-limited-key-{uuid.uuid4()}")
    try:
        await mcp_server.search_rules(query="refund")
        await mcp_server.search_rules(query="refund")
        with pytest.raises(RuntimeError, match="rate limit"):
            await mcp_server.search_rules(query="refund")
    finally:
        _reset_context(tokens)


async def test_get_rule_malformed_id_returns_error_not_crash(seeded_org):
    """A caller passing a non-UUID string used to hit session.get() and
    blow up with a raw asyncpg error instead of the same generic refusal
    every other not-found/not-approved/cross-org case gets. store-backed
    rule ids are still real uuid4 strings (see routers/rules.py's
    create_rule), so the same shape check still applies."""
    tokens = _set_context(seeded_org["org_id"])
    try:
        with pytest.raises(RuntimeError, match="no approved rule"):
            await mcp_server.get_rule("not-a-uuid")
    finally:
        _reset_context(tokens)


async def test_search_rules_rejects_non_positive_limit(seeded_org):
    """limit=0 or negative used to pass straight through to SQL's LIMIT
    instead of being clamped to at least 1."""
    tokens = _set_context(seeded_org["org_id"])
    try:
        hits = await mcp_server.search_rules(query="refund", limit=-5)
    finally:
        _reset_context(tokens)

    assert len(hits) >= 1


class _UnreachableRedisPool:
    """Same stand-in as tests/test_rate_limit.py's — duplicated locally
    rather than imported so this file's tests don't reach across test
    modules for a fixture, matching this file's own existing style of
    self-contained helpers (_rule_dict, _set_context, etc)."""

    async def incr(self, key):
        raise redis.exceptions.ConnectionError("Error 61 connecting to redis. Connection refused.")

    async def expire(self, key, ttl):
        raise redis.exceptions.ConnectionError("Error 61 connecting to redis. Connection refused.")

    async def eval(self, *args, **kwargs):
        raise redis.exceptions.ConnectionError("Error 61 connecting to redis. Connection refused.")


async def test_check_action_accepts_deprecated_action_alias():
    """Pre-rename callers still sending `action` instead of `description`
    must keep working, not just get a warning — see check_action's own
    docstring. No rules exist for this org, so retrieval comes back empty
    and the judge never runs (evaluate_action's own no_coverage branch) —
    what's under test here is only that the deprecated param name reaches
    evaluate_action at all instead of erroring as a missing required arg."""
    tokens = _set_context(f"__mcp_test_{uuid.uuid4().hex[:8]}__")
    try:
        result = await mcp_server.check_action(action="issue a refund")
    finally:
        _reset_context(tokens)

    assert result["verdict"] == "needs_human"
    assert result["no_coverage"] is True


async def test_check_action_missing_description_and_action_raises():
    tokens = _set_context(f"__mcp_test_{uuid.uuid4().hex[:8]}__")
    try:
        with pytest.raises(RuntimeError, match="description"):
            await mcp_server.check_action()
    finally:
        _reset_context(tokens)


async def test_check_action_grounded_verdict_through_real_retrieval(seeded_org, monkeypatch):
    """check_action retrieves through the same real, org-scoped store path as
    search_rules, then grounds the verdict in what came back. The LLM judge is
    stubbed (Global Rule 6 — no real model calls in the test loop) but the
    retrieval and the grounding gate are exercised for real: the stub cites a
    rule this org actually retrieved, so the verdict flips off the needs_human
    default to blocked."""
    from gnt.action_check import CheckActionJudgment
    from gnt.config import get_settings as real_get_settings

    # action_check reads its own get_settings; drop the threshold so the fake
    # (non-semantic) test embedding can't filter out this org's rules.
    no_threshold = real_get_settings().model_copy(
        update={"search_rules_similarity_threshold": -1.0}
    )
    monkeypatch.setattr("gnt.action_check.get_settings", lambda: no_threshold)

    def _stub_judge(description, context, rules):
        # Ground the verdict in a rule that was actually retrieved for this org.
        # judge_action returns (judgment, input_tokens, output_tokens) — see
        # its own docstring on why (C9a's cost tracking).
        first_id = rules[0]["slug"].removeprefix("rules/")
        return CheckActionJudgment(verdict="blocked", cited_rule_ids=[first_id], reason="stub"), 100, 20

    monkeypatch.setattr("gnt.action_check.judge_action", _stub_judge)

    tokens = _set_context(seeded_org["org_id"])
    try:
        # "refund window" lexically matches the seeded "Refund window" rule.
        # item 11: retrieval is hybrid now, and its keyword arm ANDs query
        # terms while the fake test embedding has no semantic arm — so a
        # description like "issue a refund" retrieves nothing (no rule
        # contains "issue"). See seeded_org's comment. The stubbed judge, not
        # the query wording, is what drives the verdict under test.
        result = await mcp_server.check_action(description="refund window")
    finally:
        _reset_context(tokens)

    assert result["verdict"] == "blocked"
    assert result["rules_retrieved"] >= 1
    assert len(result["cited_rules"]) == 1


async def test_check_action_cross_tenant_sees_no_rules_and_needs_human(seeded_org, monkeypatch):
    """Tenant isolation on the enforcement path: a different org retrieves
    none of seeded_org's approved rules, so check_action returns needs_human
    with zero coverage — and the judge is never invoked, proving the other
    org's rules never even reach the model."""
    def _judge_should_not_run(*args, **kwargs):
        raise AssertionError("judge must not run for an org with no approved rules")

    monkeypatch.setattr("gnt.action_check.judge_action", _judge_should_not_run)

    tokens = _set_context("__mcp_test_other_org__")
    try:
        result = await mcp_server.check_action(description="issue a refund")
    finally:
        _reset_context(tokens)

    assert result["verdict"] == "needs_human"
    assert result["rules_retrieved"] == 0


async def test_mcp_search_rules_fails_closed_when_redis_unreachable(monkeypatch):
    """search_rules enforces its per-key sliding-window budget before
    calling out to the store, so an unreachable Redis must reject the
    call outright rather than serving results as if under budget."""
    monkeypatch.setattr(rate_limit, "get_pool", lambda: _UnreachableRedisPool())

    tokens = _set_context(f"__mcp_test_{uuid.uuid4().hex[:8]}__")
    try:
        with pytest.raises(redis.exceptions.ConnectionError):
            await mcp_server.search_rules(query="refund")
    finally:
        _reset_context(tokens)


async def _gap_rows(db_session, org_id: str) -> list[RuleGap]:
    from gnt.db.rls import scope_to_org

    await scope_to_org(db_session, org_id)
    return (await db_session.execute(select(RuleGap).where(RuleGap.org_id == org_id))).scalars().all()


async def test_search_rules_zero_hits_logs_gap(db_session):
    """fix-plan-v2 item 8: a search_rules call that comes back empty is
    exactly gap_tracking.py's search_rules gap definition. This org has no
    rules at all in the store, so zero hits is guaranteed regardless of the
    similarity threshold."""
    org_id = f"__mcp_test_{uuid.uuid4().hex[:8]}__"
    await ensure_org(db_session, org_id)
    await db_session.commit()

    tokens = _set_context(org_id)
    try:
        hits = await mcp_server.search_rules(query="a query nothing covers")
    finally:
        _reset_context(tokens)

    assert hits == []
    rows = await _gap_rows(db_session, org_id)
    assert len(rows) == 1
    assert rows[0].tool == "search_rules"
    assert rows[0].query_text == "a query nothing covers"


async def test_search_rules_with_hits_does_not_log_gap(seeded_org, db_session):
    org_id = seeded_org["org_id"]
    await ensure_org(db_session, org_id)
    await db_session.commit()

    tokens = _set_context(org_id)
    try:
        hits = await mcp_server.search_rules(query="refund")
    finally:
        _reset_context(tokens)

    assert len(hits) > 0
    assert await _gap_rows(db_session, org_id) == []


async def test_check_action_no_coverage_logs_gap(db_session, monkeypatch):
    """The no-coverage needs_human branch (rules_retrieved == 0, judge never
    invoked) is exactly gap_tracking.py's check_action gap definition."""
    def _judge_should_not_run(*args, **kwargs):
        raise AssertionError("judge must not run for an org with no approved rules")

    monkeypatch.setattr("gnt.action_check.judge_action", _judge_should_not_run)

    org_id = f"__mcp_test_{uuid.uuid4().hex[:8]}__"
    await ensure_org(db_session, org_id)
    await db_session.commit()

    tokens = _set_context(org_id)
    try:
        result = await mcp_server.check_action(description="issue a refund nobody has a policy for")
    finally:
        _reset_context(tokens)

    assert result["verdict"] == "needs_human"
    assert result["no_coverage"] is True
    rows = await _gap_rows(db_session, org_id)
    assert len(rows) == 1
    assert rows[0].tool == "check_action"
    assert rows[0].query_text == "issue a refund nobody has a policy for"


async def test_check_action_ambiguous_needs_human_does_not_log_gap(seeded_org, db_session, monkeypatch):
    """needs_human because the retrieved rules don't clearly govern the
    action (rules_retrieved > 0, no_coverage False) is NOT a coverage gap —
    the org has rules, the model just wasn't confident. Proves gap logging
    doesn't fall back to guessing off rules_retrieved == 0 alone."""
    from gnt.action_check import CheckActionJudgment
    from gnt.config import get_settings as real_get_settings

    no_threshold = real_get_settings().model_copy(update={"search_rules_similarity_threshold": -1.0})
    monkeypatch.setattr("gnt.action_check.get_settings", lambda: no_threshold)

    def _judge_ungrounded(description, context, rules):
        return CheckActionJudgment(verdict="needs_human", cited_rule_ids=[], reason="ambiguous"), 100, 20

    monkeypatch.setattr("gnt.action_check.judge_action", _judge_ungrounded)

    org_id = seeded_org["org_id"]
    await ensure_org(db_session, org_id)
    await db_session.commit()

    tokens = _set_context(org_id)
    try:
        # "refund window" retrieves the seeded rule (item 11 hybrid keyword
        # arm needs a lexical match — see seeded_org's comment); the stubbed
        # judge returns an ungrounded needs_human regardless, which is the
        # rules_retrieved>0-but-not-a-coverage-gap branch this test exercises.
        result = await mcp_server.check_action(description="refund window")
    finally:
        _reset_context(tokens)

    assert result["verdict"] == "needs_human"
    assert result["rules_retrieved"] > 0
    assert result["no_coverage"] is False


# --- fix-plan-v2 item 10: roi_counters bumped on the same hot-path calls ---


async def _roi_row(db_session, org_id: str) -> RoiCounter | None:
    from gnt.db.rls import scope_to_org

    await scope_to_org(db_session, org_id)
    return (
        await db_session.execute(
            select(RoiCounter).where(
                RoiCounter.org_id == org_id, RoiCounter.day == datetime.now(timezone.utc).date()
            )
        )
    ).scalar_one_or_none()


async def test_search_rules_with_hits_bumps_rules_served(seeded_org, db_session):
    """rules_served counts individual rule objects served, not calls made —
    the counter should reflect however many rules actually came back, not a
    flat 1 per call. (item 11: hybrid retrieval's keyword arm ANDs terms, so
    "refund" now matches only the seeded "Refund window" rule, not "Shipping
    window" too; the assertion binds to len(hits) either way.)"""
    org_id = seeded_org["org_id"]
    await ensure_org(db_session, org_id)
    await db_session.commit()

    tokens = _set_context(org_id)
    try:
        hits = await mcp_server.search_rules(query="refund")
    finally:
        _reset_context(tokens)

    row = await _roi_row(db_session, org_id)
    assert row is not None
    assert row.rules_served == len(hits)
    assert row.actions_checked == 0


async def test_search_rules_zero_hits_does_not_bump_rules_served(db_session):
    """Zero hits is a coverage gap (see test_search_rules_zero_hits_logs_gap
    above), not a served rule — nothing should be counted as served."""
    org_id = f"__mcp_test_{uuid.uuid4().hex[:8]}__"
    await ensure_org(db_session, org_id)
    await db_session.commit()

    tokens = _set_context(org_id)
    try:
        hits = await mcp_server.search_rules(query="a query nothing covers")
    finally:
        _reset_context(tokens)

    assert hits == []
    assert await _roi_row(db_session, org_id) is None


async def test_get_rule_bumps_rules_served(seeded_org, db_session):
    org_id = seeded_org["org_id"]
    await ensure_org(db_session, org_id)
    await db_session.commit()

    tokens = _set_context(org_id)
    try:
        await mcp_server.get_rule(rule_id=_bare_id(seeded_org["approved"]))
    finally:
        _reset_context(tokens)

    row = await _roi_row(db_session, org_id)
    assert row is not None
    assert row.rules_served == 1


async def test_get_rule_not_found_does_not_bump_rules_served(db_session):
    org_id = f"__mcp_test_{uuid.uuid4().hex[:8]}__"
    await ensure_org(db_session, org_id)
    await db_session.commit()

    tokens = _set_context(org_id)
    try:
        with pytest.raises(RuntimeError, match="no approved rule"):
            await mcp_server.get_rule(rule_id=str(uuid.uuid4()))
    finally:
        _reset_context(tokens)

    assert await _roi_row(db_session, org_id) is None


async def test_check_action_blocked_bumps_actions_checked_and_blocked(seeded_org, db_session, monkeypatch):
    from gnt.action_check import CheckActionJudgment
    from gnt.config import get_settings as real_get_settings

    no_threshold = real_get_settings().model_copy(update={"search_rules_similarity_threshold": -1.0})
    monkeypatch.setattr("gnt.action_check.get_settings", lambda: no_threshold)

    def _stub_judge(description, context, rules):
        first_id = rules[0]["slug"].removeprefix("rules/")
        return CheckActionJudgment(verdict="blocked", cited_rule_ids=[first_id], reason="stub"), 100, 20

    monkeypatch.setattr("gnt.action_check.judge_action", _stub_judge)

    org_id = seeded_org["org_id"]
    await ensure_org(db_session, org_id)
    await db_session.commit()

    tokens = _set_context(org_id)
    try:
        # "refund window" lexically matches the seeded "Refund window" rule so
        # hybrid retrieval's keyword arm returns it (item 11 — see seeded_org's
        # comment); the stubbed judge drives the blocked verdict under test.
        result = await mcp_server.check_action(description="refund window")
    finally:
        _reset_context(tokens)

    assert result["verdict"] == "blocked"
    row = await _roi_row(db_session, org_id)
    assert row is not None
    assert row.actions_checked == 1
    assert row.actions_blocked == 1
    assert row.actions_needs_human == 0


async def test_check_action_no_coverage_bumps_actions_checked_and_needs_human(db_session, monkeypatch):
    def _judge_should_not_run(*args, **kwargs):
        raise AssertionError("judge must not run for an org with no approved rules")

    monkeypatch.setattr("gnt.action_check.judge_action", _judge_should_not_run)

    org_id = f"__mcp_test_{uuid.uuid4().hex[:8]}__"
    await ensure_org(db_session, org_id)
    await db_session.commit()

    tokens = _set_context(org_id)
    try:
        result = await mcp_server.check_action(description="issue a refund nobody has a policy for")
    finally:
        _reset_context(tokens)

    assert result["verdict"] == "needs_human"
    row = await _roi_row(db_session, org_id)
    assert row is not None
    assert row.actions_checked == 1
    assert row.actions_blocked == 0
    assert row.actions_needs_human == 1

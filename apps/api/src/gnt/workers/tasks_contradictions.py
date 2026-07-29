"""Nightly cross-time contradiction sweep, which also opens a
proposed-resolution PR alongside the GitHub issue it files.
pipeline/rule_conflict.py's judge_conflict only ever runs at
propose-time, comparing a new rule against its single nearest approved
neighbor — two rules approved months apart, never proposed near each
other, can contradict silently forever. This job re-runs that exact same
comparison (never a reimplementation) across an org's already-approved
corpus on a schedule, and hands anything it finds to a human via a GitHub
issue AND a proposed-resolution PR on the org's connected rules repo.

Follows workers/tasks_staleness.py's reference two-tier session pattern
for every cron job in this codebase (see that module's own docstring for
the full reasoning): enumerate org ids through get_cron_sessionmaker()
(BYPASSRLS, the narrow gnt_cron exemption), then do every actual per-org
read/write through a normal scope_to_org'd session, one org at a time,
never a single cross-org statement.

Never deprecates or otherwise changes rule_a/rule_b's own status directly
— that's a hard constraint on this sweep, not a preference, and it's
structurally true of this file: nothing here imports put_rule,
deprecate_rule, or approve_rule, or calls any of them directly. What this
module DOES write is a brand new draft row proposing one
concrete resolution — routers/rules.py's create_rule_amendment +
submit_rule_for_review + propose_rule_for_org, the exact same
edit-then-submit-then-propose lifecycle a human amending an approved rule
through the API gets, triggered here programmatically instead of from an
HTTP caller. That new row's own status moves draft -> in_review ->
pending_merge, same as any other proposed rule, but rule_a/rule_b
themselves are never touched — only a human merging the resulting PR on
GitHub can ever move a rule to `approved` or `deprecated` (see
routers/github_webhook.py). The only writes this module makes directly
are a GitHub issue, a proposed-resolution PR (via the helpers above), and
a ContradictionFinding row recording both.

Cost-bounded per org per run by two independent Settings knobs (see
config.py): contradiction_sweep_max_comparisons_per_org caps how many
judge_conflict calls one org's run can spend, and
contradiction_sweep_max_issues_per_org separately caps how many new
issues (each with at most one proposed-resolution PR attempt riding along
with it) it can open — a pair already on file in ContradictionFinding
(gnt.contradiction_findings.has_been_filed) is skipped for free and
counts against neither budget.
"""

import asyncio
from typing import Any

import sentry_sdk
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.config import get_settings
from gnt.contradiction_findings import canonical_pair, has_been_filed, record_finding
from gnt.db.models import GithubConnection, Org
from gnt.db.rls import scope_to_org
from gnt.db.session import get_cron_sessionmaker, get_sessionmaker
from gnt.github.app_auth import GithubAppError, get_repo_token
from gnt.github.client import IssueResult, create_issue
from gnt.llm_quota import check_llm_quota, record_llm_usage
from gnt.pipeline.rule_conflict import judge_conflict
from gnt.routers.rules import (
    CreateRuleRequest,
    create_rule_amendment,
    propose_rule_for_org,
    submit_rule_for_review,
)
from gnt.store_client import StoreClientError
from gnt.store_client import list_rules as store_list_rules
from gnt.store_client import search_rules

# The actor id this module's own writes (the amendment draft, its submit,
# its propose) are attributed to — same bare-string, no-session-behind-it
# convention routers/webhooks.py's ingest_webhook already uses for
# create_draft_rule's "webhook" caller, since a nightly cron job has no
# more of a real human user_id behind it than a webhook delivery does.
_SWEEP_ACTOR_ID = "contradiction-sweep"

# Candidate pairs are generated with this much headroom over the
# comparisons budget before any judging starts, so pairs that turn out to
# already be on file in ContradictionFinding (free to skip, no LLM call)
# don't starve the run of anything left to actually judge. Small, fixed
# multiplier — not unbounded — so sampling itself stays cheap even for a
# corpus with hundreds of rules.
_CANDIDATE_HEADROOM_MULTIPLIER = 3


async def sweep_contradictions(ctx: dict[str, Any]) -> None:
    """arq cron entrypoint (see worker.py's cron_jobs). Enumerates every
    org, then runs that org's own contradiction sweep — see module
    docstring for why enumeration and the per-org work use two different
    sessions/roles."""
    cron_session_factory = get_cron_sessionmaker()
    async with cron_session_factory() as session:
        org_ids = [row[0] for row in (await session.execute(select(Org.id))).all()]

    for org_id in org_ids:
        # One org's failure (a store outage, a bad GitHub token, an
        # unexpected exception anywhere in this org's own sweep) must never
        # take down the rest of the night's orgs — same per-org isolation
        # tasks_zendesk.py/tasks_intercom.py already give their own sync
        # loops. _process_pair already isolates per-pair failures inside a
        # single org's run; this is the outer, per-org layer of the same
        # discipline.
        try:
            await sweep_contradictions_for_org(org_id)
        except Exception as exc:
            sentry_sdk.capture_exception(exc)


async def sweep_contradictions_for_org(org_id: str) -> None:
    """The per-org unit of work sweep_contradictions loops over — mirrors
    tasks_staleness.py's compute_staleness_for_org shape: takes an
    org_id, opens its own scope_to_org'd session, does the work. An org
    with no connected GitHub repo has nowhere to file a finding, so it's
    skipped outright — not an error, plenty of orgs won't have connected
    one yet."""
    settings = get_settings()
    session_factory = get_sessionmaker()
    async with session_factory() as session:
        await scope_to_org(session, org_id)
        connection = (
            await session.execute(select(GithubConnection).where(GithubConnection.org_id == org_id))
        ).scalar_one_or_none()
        if connection is None:
            return
        try:
            pat = await get_repo_token(connection)
        except GithubAppError as exc:
            # An App-connected org whose installation token mint fails has
            # nowhere to file a finding tonight, same as "no connection at
            # all" above — the nightly cron just runs again tomorrow.
            sentry_sdk.capture_exception(exc)
            return

        rules = await store_list_rules(org_id, status="approved")
        if len(rules) < 2:
            return

        max_candidates = settings.contradiction_sweep_max_comparisons_per_org * _CANDIDATE_HEADROOM_MULTIPLIER
        candidate_pairs = await sample_candidate_pairs(org_id, rules, max_candidates)

        comparisons_used = 0
        issues_filed = 0
        for rule_a, rule_b in candidate_pairs:
            if comparisons_used >= settings.contradiction_sweep_max_comparisons_per_org:
                break
            if issues_filed >= settings.contradiction_sweep_max_issues_per_org:
                break
            # Per-org LLM spend quota check, checked before every
            # judge_conflict call this loop is about to make, same
            # quiet-break shape as the two budget checks above (not an
            # exception-per-pair loop — see gnt.llm_quota's own docstring
            # on why this call site uses the bool shape instead of
            # enforce_llm_quota's raising one).
            if not await check_llm_quota(org_id):
                break
            attempted, filed = await _process_pair(session, org_id, connection, pat, rule_a, rule_b)
            if attempted:
                comparisons_used += 1
            if filed:
                issues_filed += 1


async def _process_pair(
    session: AsyncSession, org_id: str, connection: GithubConnection, pat: str, rule_a: dict, rule_b: dict
) -> tuple[bool, bool]:
    """One candidate pair, start to finish. Returns (attempted_comparison,
    filed): attempted_comparison is True only once judge_conflict was
    actually called (a dedup hit, or any failure before that point, costs
    nothing and must not count against the per-run comparisons budget);
    filed is True only once a GitHub issue was actually opened and
    recorded.

    Wraps the whole pair — dedup check through issue filing — in one
    broad except, the same "one bad candidate never derails the rest of
    the run" discipline pipeline/rule_conflict.py's find_conflict already
    applies to propose-time conflict checks: a store hiccup, a malformed
    rule dict, a GitHub API error, or an LLM error here skips this one
    pair, never the org's whole nightly sweep. The proposed-resolution PR
    (_propose_resolution below) has its own, narrower try/except inside
    it for the same "isolated failure" reason, one level down: a PR that
    fails to open must not undo the issue that already succeeded, or
    leave has_been_filed False and invite a duplicate issue next run —
    see that function's own docstring."""
    slug_a, slug_b = canonical_pair(rule_a["slug"], rule_b["slug"])
    try:
        if await has_been_filed(session, org_id, slug_a, slug_b):
            return False, False

        verdict, input_tokens, output_tokens = await asyncio.to_thread(
            judge_conflict, rule_a["title"], rule_a["body"], rule_b["title"], rule_b["body"]
        )
        await record_llm_usage(org_id, get_settings().rule_merge_model, input_tokens, output_tokens)
        if verdict.relation != "contradicts":
            # duplicate/refines/distinct are propose-time signals
            # (find_conflict already surfaces them in the PR body when a
            # rule is proposed near an existing one) — this sweep exists
            # specifically for the case that check can't catch: rules
            # approved months apart that actively contradict each other.
            # Filing an issue for every duplicate or refinement it also
            # happens to notice would swamp a repo with low-value noise.
            return True, False

        issue = await create_issue(
            connection.repo_url, pat, _issue_title(rule_a, rule_b), _issue_body(rule_a, rule_b, verdict)
        )
        # A real proposed-resolution PR alongside the
        # issue above, not instead of it: the issue stays the durable,
        # searchable record of the finding even if the PR attempt below
        # fails or a human rejects it outright; the PR is the upgrade,
        # "here's one concrete fix you can just merge if you agree."
        # Best-effort on purpose (see _propose_resolution's own
        # docstring) — its failure must never undo the issue this pair
        # already got, or stop record_finding below from marking the pair
        # filed.
        pr_number, pr_url = await _propose_resolution(
            session, org_id, connection, pat, rule_a, rule_b, verdict, issue
        )
        await record_finding(
            session,
            org_id,
            slug_a,
            slug_b,
            relation=verdict.relation,
            issue_number=issue.number,
            issue_url=issue.url,
            pr_number=pr_number,
            pr_url=pr_url,
        )
        return True, True
    except Exception as exc:
        sentry_sdk.capture_exception(exc)
        return False, False


def _order_by_approval(rule_a: dict, rule_b: dict) -> tuple[dict, dict]:
    """Which of the two contradicting rules gets amended: the one approved
    EARLIER defers to the one approved later. Reasoning (this sweep's own
    call, not dictated by anything upstream): the whole reason this sweep
    exists is that judge_conflict at propose-time only ever compares a new
    rule against its nearest neighbor, so the pairs it catches here are
    routinely rules "approved months apart" (see module docstring) — the
    older approval is the one more likely to reflect stale context, same
    underlying signal workers/tasks_staleness.py already tracks
    (approvedAt/lastValidatedAt) for "which rule is more likely outdated."
    Amending the older rule to defer to the newer one, not the reverse,
    keeps the annotation's own wording ("may be superseded by") consistent
    with what "superseded" ordinarily means — a newer thing superseding an
    older one, not the other way around.

    Ties (or a missing approvedAt, which shouldn't happen for a rule this
    sweep only ever pulls from store_list_rules(status="approved"), but
    isn't asserted away here) break on slug, so a rerun picks the same
    rule to amend as any earlier run did."""
    ordered = sorted((rule_a, rule_b), key=lambda r: (r.get("approvedAt") or "", r["slug"]))
    return ordered[0], ordered[1]


def _amended_body(older: dict, newer: dict) -> str:
    """The one concrete resolution this sweep proposes: the older rule's
    body, unchanged, with a note appended flagging the contradiction and
    pointing at the newer rule — never a rewrite of the older rule's own
    substance, since this sweep has no way to know which rule is actually
    *right*, only which pair contradicts and which of the two is more
    likely stale. Matches _issue_body's own "estimate, not a verified
    fact" voice below. Sanitized once more (on top of whatever sanitize()
    pass `older`/`newer`'s own title/body already went through at approval
    time) by create_rule_amendment, same as every other path that composes
    a new stored artifact out of already-approved rule text — see that
    function's own docstring."""
    return (
        f"{older['body']}\n\n"
        f"Note: this rule may be superseded by \"{newer['title']}\" (`{newer['slug']}`) — a nightly "
        "sweep flagged a possible contradiction between them; review both before relying on this one."
    )


async def _propose_resolution(
    session: AsyncSession,
    org_id: str,
    connection: GithubConnection,
    pat: str,
    rule_a: dict,
    rule_b: dict,
    verdict: Any,
    issue: IssueResult,
) -> tuple[int | None, str | None]:
    """Pushes one concrete resolution — the older of the two contradicting
    rules (_order_by_approval), amended (_amended_body) to defer to the
    newer one — through the exact same edit -> submit -> propose lifecycle
    a human amending an approved rule through the API gets
    (routers/rules.py's create_rule_amendment, submit_rule_for_review,
    propose_rule_for_org), triggered here programmatically instead of from
    an HTTP caller. The new draft's own status moves draft -> in_review ->
    pending_merge; `older`/`newer` themselves are never written by this
    module (see module docstring) — only a human merging the resulting PR
    on GitHub can move anything to `approved`, same "the merge button
    stays human" guarantee every other proposed rule in this codebase
    already has.

    Never raises — this is explicitly best-effort on top of an issue that
    has already been filed by the time this runs (see _process_pair): a
    failure anywhere here (the draft creation, the submit, GitHub
    rejecting the branch/file/PR calls, an unrelated store hiccup) still
    leaves that already-filed issue as the durable record for this pair.
    The only cost of a failure here is one fewer proposed-resolution PR,
    never a re-flagged pair or a lost issue — record_finding still runs
    right after this returns regardless of whether it got a real
    (pr_number, pr_url) back or (None, None)."""
    try:
        older, newer = _order_by_approval(rule_a, rule_b)
        amendment_request = CreateRuleRequest(
            title=older["title"],
            body=_amended_body(older, newer),
            confidence=older["confidence"],
            source_citations=older.get("sourceCitations") or [],
            source=older.get("source"),
            tags=older.get("tags") or [],
        )
        draft = await create_rule_amendment(org_id, _SWEEP_ACTOR_ID, older, amendment_request, session)
        draft = await submit_rule_for_review(org_id, _SWEEP_ACTOR_ID, draft)

        pr_title = f"Resolve contradiction: {older['title']}"
        pr_intro = (
            "Opened automatically by gnt's nightly contradiction sweep — proposes "
            f"one concrete resolution for the contradiction flagged in issue #{issue.number}. This PR "
            "amends the older of the two rules below to defer to the newer one; merging it approves "
            "the amendment exactly like any other proposed rule. Reject, edit, or close this PR instead "
            "if the proposed resolution isn't the right one — nothing about it is auto-approved.\n\n"
            f"**Relation:** {verdict.relation} (model-assigned estimate — not a verified fact)\n"
            f"**Explanation:** {verdict.explanation}\n\n"
            f"- `{older['slug']}` — {older['title']} (amended by this PR)\n"
            f"- `{newer['slug']}` — {newer['title']} (unchanged)"
        )
        _draft, pr = await propose_rule_for_org(
            org_id, _SWEEP_ACTOR_ID, draft, connection, pat, session, pr_title=pr_title, pr_intro=pr_intro
        )
        return pr.number, pr.url
    except Exception as exc:
        sentry_sdk.capture_exception(exc)
        return None, None


def _issue_title(rule_a: dict, rule_b: dict) -> str:
    return f"Possible contradiction: {rule_a['title']} vs {rule_b['title']}"


def _issue_body(rule_a: dict, rule_b: dict, verdict: Any) -> str:
    return (
        "Opened automatically by gnt's nightly contradiction sweep — "
        "a human needs to resolve this. Nothing about this issue changes either rule's status "
        "directly; the sweep never deprecates or edits `rule_a`/`rule_b` themselves.\n\n"
        f"**Relation:** {verdict.relation} (model-assigned estimate — not a verified fact)\n"
        f"**Explanation:** {verdict.explanation}\n\n"
        f"- `{rule_a['slug']}` — {rule_a['title']}\n"
        f"- `{rule_b['slug']}` — {rule_b['title']}\n\n"
        "The sweep also tries to open a pull request proposing one concrete resolution (amending "
        "the older of the two rules to defer to the newer one) — check this repo's open PRs from "
        "`gnt` for one referencing this issue. If no such PR shows up, that attempt didn't succeed "
        "this run; review both rules by hand instead and either edit one to resolve the conflict, "
        "deprecate whichever is outdated, or close this issue if it turns out not to be a real "
        "contradiction."
    )


def _same_tag_pairs(rules: list[dict], max_pairs: int) -> list[tuple[dict, dict]]:
    """Same-topic-first candidate generation: rules sharing a tag are the
    ones most likely to actually contradict, so they're compared before
    anything else. Groups approved rules by shared tag and pairs
    within each group before anything else runs. Tags are iterated in
    sorted order and each group's rules in list order, so a given corpus
    produces the same candidate pairs run to run. A pair sharing more
    than one tag is still only ever compared once (`seen` dedupes on the
    rule-slug pair, not the tag it was found under)."""
    by_tag: dict[str, list[dict]] = {}
    for rule in rules:
        for tag in rule.get("tags") or []:
            by_tag.setdefault(tag, []).append(rule)

    seen: set[frozenset[str]] = set()
    pairs: list[tuple[dict, dict]] = []
    for tag in sorted(by_tag):
        group = by_tag[tag]
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                if len(pairs) >= max_pairs:
                    return pairs
                a, b = group[i], group[j]
                key = frozenset((a["slug"], b["slug"]))
                if key in seen:
                    continue
                seen.add(key)
                pairs.append((a, b))
    return pairs


async def _fallback_pairs_via_search(
    org_id: str, rules: list[dict], covered: set[str], remaining_budget: int
) -> list[tuple[dict, dict]]:
    """Second tier, once same-tag pairing is exhausted (or a rule shares
    no tag with anything else approved): reuses search_rules — the same
    retrieval pipeline/rule_conflict.py's find_conflict already leans on
    at propose-time — to find each still-uncovered rule's nearest
    approved neighbor by content, rather than pairing it with an
    arbitrary other rule or falling back to full O(n^2) comparison across
    the whole corpus. At most one search_rules call per uncovered rule
    (not per pair), so this stays linear in corpus size even though
    same-tag pairing above is not."""
    if remaining_budget <= 0:
        return []
    by_slug = {rule["slug"]: rule for rule in rules}
    uncovered = [rule for rule in rules if rule["slug"] not in covered]

    seen: set[frozenset[str]] = set()
    pairs: list[tuple[dict, dict]] = []
    for rule in uncovered:
        if len(pairs) >= remaining_budget:
            break
        try:
            hits = await search_rules(org_id, f"{rule['title']}\n{rule['body']}")
        except StoreClientError:
            continue
        candidate = next((hit for hit in hits if hit.get("slug") != rule["slug"]), None)
        if candidate is None or candidate["slug"] not in by_slug:
            continue
        key = frozenset((rule["slug"], candidate["slug"]))
        if key in seen:
            continue
        seen.add(key)
        pairs.append((rule, by_slug[candidate["slug"]]))
    return pairs


async def sample_candidate_pairs(org_id: str, rules: list[dict], max_pairs: int) -> list[tuple[dict, dict]]:
    """Which pairs are worth comparing tonight: same-tag pairs first
    (_same_tag_pairs, pure and cheap), then — only if budget remains —
    a content-similarity fallback (_fallback_pairs_via_search) for
    whatever rules the tag pass never covered at all. Never compares
    every pair in the corpus; always bounded by max_pairs."""
    pairs = _same_tag_pairs(rules, max_pairs)
    if len(pairs) < max_pairs:
        covered = {slug for pair in pairs for slug in (pair[0]["slug"], pair[1]["slug"])}
        pairs = pairs + await _fallback_pairs_via_search(org_id, rules, covered, max_pairs - len(pairs))
    return pairs

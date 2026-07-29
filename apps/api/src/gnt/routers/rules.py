import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.auth.better_auth import OrgContext, get_current_org, require_admin
from gnt.billing import require_entitled_admin
from gnt.calibration import (
    log_conflict_flagged,
    log_deprecation,
    log_revalidation_if_previously_stale,
)
from gnt.config import get_settings
from gnt.db.models import GithubConnection
from gnt.db.org import ensure_org
from gnt.db.session import get_session
from gnt.github.app_auth import GithubAppError, get_repo_token
from gnt.github.client import (
    GithubClientError,
    PullRequestResult,
    close_pull_request,
    create_branch,
    open_pull_request,
    put_file,
)
from gnt.github.render import render_rule_markdown
from gnt.onboarding_metrics import log_onboarding_event
from gnt.pipeline.privacy_gate import mask_fields
from gnt.pipeline.privacy_gate.redaction_record import build_redaction_record
from gnt.pipeline.rule_conflict import find_conflict
from gnt.pipeline.sanitize import sanitize
from gnt.staleness import list_due_for_revalidation, rule_freshness
from gnt.store_client import append_audit, get_rule as store_get_rule
from gnt.store_client import list_rules as store_list_rules
from gnt.store_client import put_rule

router = APIRouter(prefix="/v1/rules", tags=["rules"])

_SLUG_PREFIX = "rules/"


def _slug(rule_id: str) -> str:
    return f"{_SLUG_PREFIX}{rule_id}"


def _bare_id(slug: str) -> str:
    return slug.removeprefix(_SLUG_PREFIX)


class CreateRuleRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=8000)
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    source_citations: list[dict] = Field(default_factory=list)
    # Free text, not the structured source_citations shape above — there's
    # no extraction pipeline left that populates source_type/source_id/
    # permalink automatically (that pipeline was retired), so whoever is
    # creating the rule by hand is never going to have those fields to
    # fill in. This is the honest, low-friction version: "a Slack thread
    # from 2026-07-10", a URL, a doc name — whatever the human or agent
    # proposing the rule actually has. Optional because plenty of rules
    # genuinely don't have one (an operator just stating a policy from
    # memory); surfaced in the PR body when present, silently absent when
    # not (see propose_rule).
    source: str | None = Field(default=None, max_length=2000)
    tags: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("tags")
    @classmethod
    def _normalize_tags(cls, tags: list[str]) -> list[str]:
        seen: set[str] = set()
        normalized = []
        for tag in tags:
            trimmed = tag.strip()
            if not trimmed or len(trimmed) > 64 or trimmed in seen:
                continue
            seen.add(trimmed)
            normalized.append(trimmed)
        return normalized

    @field_validator("source")
    @classmethod
    def _normalize_source(cls, source: str | None) -> str | None:
        if source is None:
            return None
        trimmed = source.strip()
        return trimmed or None


class RejectRuleRequest(BaseModel):
    reason: str | None = None


class BatchProposeRequest(BaseModel):
    """Batches several already-in_review rules into ONE
    PR instead of propose_rule's one-PR-per-rule. A deliberate design
    choice (not "fake" batching via pacing individual propose_rule calls): the
    customer reviews 5-8 related rules as a single PR, not 5-8 separate
    ones."""

    rule_ids: list[str] = Field(min_length=1)


def _serialize(rule: dict[str, Any]) -> dict[str, Any]:
    """Maps apps/store's RulePage JSON shape (camelCase, from the TS side)
    back onto the exact response shape this REST API returned when rules
    lived directly in Postgres — the field NAMES stay stable across the
    migration (no known frontend consumer yet, but no reason to break the
    contract anyway). `id` changes from a raw UUID to a bare id derived
    from the store's slug — see _slug/_bare_id."""
    return {
        "id": _bare_id(rule["slug"]),
        "title": rule["title"],
        "body": rule["body"],
        "status": rule["status"],
        "confidence": rule["confidence"],
        # Confidence is a model-assigned score set
        # once at creation time, never independently checked against
        # reality. Labeled explicitly, same convention as freshness's own
        # "estimate" field below, so it never reads as a verified
        # measurement — see mcp_server/server.py's identical field.
        "confidence_estimate": True,
        "owner_user_id": rule["ownerId"],
        "source_citations": rule["sourceCitations"],
        # .get, not [] — rules created before this field existed won't
        # have the key in the store's stored JSON at all.
        "source": rule.get("source"),
        "tags": rule["tags"],
        "last_validated_at": rule["lastValidatedAt"],
        "version": rule["version"],
        "superseded_by": _bare_id(rule["supersededBy"]) if rule["supersededBy"] else None,
        "previous_version_id": _bare_id(rule["previousVersionId"]) if rule["previousVersionId"] else None,
        "approved_by": rule["approvedBy"],
        "approved_at": rule["approvedAt"],
        "created_at": rule["createdAt"],
        "pr_number": rule.get("prNumber"),
        "pr_url": rule.get("prUrl"),
        # None for a rule that's never been approved
        # (draft/in_review/pending_merge have no approvedAt yet). Computed
        # live, always an explicit estimate — see mcp_server/server.py's
        # identical field for the full reasoning.
        "freshness": rule_freshness(rule),
    }


async def _get_org_rule(org_id: str, rule_id: str) -> dict[str, Any]:
    """No for_update param — unlike the Postgres-backed version this
    replaces, apps/store's GntStore has no row-lock primitive (the engine's
    putPage exposes no compare-and-swap either). approve_rule's supersede
    step below documents the resulting race window explicitly rather
    than silently losing the guarantee PR #11's SELECT ... FOR UPDATE
    provided. Cross-org isolation itself is NOT weakened — the store
    enforces sourceId scoping independently of this function."""
    rule = await store_get_rule(org_id, _slug(rule_id))
    if rule is None:
        raise HTTPException(status_code=404, detail="not found")
    return rule


async def create_draft_rule(
    org_id: str, user_id: str, body: CreateRuleRequest, *, apply_privacy_gate: bool = False
) -> dict[str, Any]:
    """The actual draft-rule-creation logic behind POST /v1/rules below —
    pulled out so routers/webhooks.py's generic ingest endpoint can create
    the exact same shape of draft rule a human/CLI caller would, through a
    completely different auth path (a URL-embedded per-org webhook token,
    not get_current_org), without duplicating the
    sanitize/rule-dict/put_rule/audit sequence. Caller is responsible for
    ensure_org + committing that first — this function only writes the
    rule itself.

    The draft-count ceiling check below (a cap on how many drafts an org
    can have open at once, guarding against runaway/automated draft
    creation) lives here, not duplicated in each router, precisely
    because this is the one function both create_rule and
    routers/webhooks.py's ingest_webhook already share — the same reason
    this function was pulled out of create_rule in the first place. Doesn't
    apply to edit_rule's new-draft-version write below (that's revising an
    already-approved rule, not runaway creation, and it doesn't call this
    function at all).

    apply_privacy_gate, default False. create_rule below
    (POST /v1/rules, a human or the CLI directly typing/submitting a rule)
    never sets it: a deliberate action by whoever's typing to expose this
    exact content to gnt doesn't need gnt masking it back at them, and
    doing so anyway would be a real UX regression, not a privacy win.
    routers/webhooks.py's ingest_webhook is the one caller that sets it
    True — that path is ambient third-party ingestion (Zapier/monday/
    HubSpot forwarding whatever a Slack thread or board comment said), with
    no human on this device having chosen to expose that specific content.
    See gnt.pipeline.privacy_gate's module docstring for the full
    architectural reasoning, including the one thing this is NOT: there is
    no detokenization step here, unlike the CLI gate — masking applied by
    this flag is permanent. A rule that's genuinely, essentially about one
    specific named person or exact figure comes out of this path with that
    detail permanently replaced by a placeholder; there is no way to
    recover it afterward. Real, deliberate tradeoff, not an oversight.

    When it does mask something, the redaction record (kind + layer per
    masked item, never the real value — see privacy_gate/redaction_record.py)
    is written to this rule's audit trail as a "privacy_gate_masked" entry,
    the same append_audit mechanism every other lifecycle event on this
    rule already uses, so a customer reviewing a webhook-ingested rule can
    see what got masked without gnt persisting a second copy of the exact
    values the gate exists to avoid ever storing."""
    limit = get_settings().max_draft_rules_per_org
    existing_drafts = await store_list_rules(org_id, status="draft")
    if len(existing_drafts) >= limit:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"draft rule limit reached ({limit} per org) — review or reject existing drafts first",
        )

    title = body.title
    rule_body = body.body
    source = body.source
    privacy_gate_hits = []
    if apply_privacy_gate:
        # One shared registry across all three fields (mask_fields), so
        # the same real value repeated across title/body/source collapses
        # onto one placeholder number rather than minting a fresh one per
        # field. Runs BEFORE sanitize() below — sanitize targets a
        # different threat (prompt-injection markers, not PII), and
        # running it after masking means a value the gate replaced with a
        # placeholder can't itself be misread as injection-shaped text.
        masked, privacy_gate_hits = mask_fields({"title": title, "body": rule_body, "source": source})
        title, rule_body, source = masked["title"], masked["body"], masked["source"]

    title = sanitize(title)
    rule_body = sanitize(rule_body)
    source = sanitize(source) if source else None
    now = datetime.now(timezone.utc).isoformat()
    rule = {
        "slug": _slug(str(uuid.uuid4())),
        "org": org_id,
        "title": title,
        "body": rule_body,
        "status": "draft",
        "confidence": body.confidence,
        "ownerId": user_id,
        "sourceCitations": body.source_citations,
        "source": source,
        "tags": body.tags,
        "lastValidatedAt": None,
        "version": 1,
        "supersededBy": None,
        "previousVersionId": None,
        "approvedBy": None,
        "approvedAt": None,
        "createdAt": now,
        "prNumber": None,
        "prUrl": None,
    }
    await put_rule(rule)
    await append_audit(
        org_id=org_id,
        rule_slug=rule["slug"],
        actor_id=user_id,
        action="created",
        before=None,
        after=rule,
    )
    if privacy_gate_hits:
        # Separate audit entry, not folded into "created" above — the
        # "created" entry's `after` is the (already-masked-if-applicable)
        # rule as stored, which does not, on its own, tell a reviewer
        # anything got masked at all. This entry is that signal, plus the
        # per-item kind/layer breakdown — see redaction_record.py's own
        # docstring for why it deliberately never carries a real value.
        # Skipped entirely (no entry at all) when nothing was masked —
        # every draft rule already gets a "created" entry regardless, so
        # this only adds a second one when there's something to say.
        await append_audit(
            org_id=org_id,
            rule_slug=rule["slug"],
            actor_id=user_id,
            action="privacy_gate_masked",
            before=None,
            after=build_redaction_record(privacy_gate_hits),
        )
    return rule


@router.post("", status_code=201)
async def create_rule(
    body: CreateRuleRequest,
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    await ensure_org(session, org.org_id)
    await session.commit()
    rule = await create_draft_rule(org.org_id, org.user_id, body)
    return _serialize(rule)


@router.get("")
async def list_rules(
    status: str | None = None,
    org: OrgContext = Depends(get_current_org),
):
    rules = await store_list_rules(org.org_id, status=status)
    rules.sort(key=lambda r: r["createdAt"], reverse=True)
    return [_serialize(r) for r in rules]


@router.get("/staleness/due")
async def get_rules_due_for_revalidation(
    limit: int = 50,
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    """Approved rules this org's last nightly compute_rule_staleness run
    flagged as past the staleness threshold — due for a human to confirm
    still true, or open a deprecation/refresh PR. Backs `gnt stale`.

    A stopgap, not the final home for this: the eventual plan is to
    surface this prompt in a weekly digest email, which doesn't exist
    yet — it's waiting on that digest itself and on the nightly
    contradiction-sweep worker (workers/tasks_contradictions.py), which
    also needs to land first. This list is the same underlying signal,
    surfaced as CLI visibility instead — wire it into the digest once
    that email exists rather than building a second parallel version of
    it.

    Registered before /{rule_id} in this file, but doesn't actually need
    to be — "staleness"/"due" are two path segments, "{rule_id}" matches
    exactly one, so there's no route collision to order around."""
    limit = max(1, min(limit, 200))
    return await list_due_for_revalidation(session, org.org_id, limit=limit)


@router.get("/{rule_id}")
async def get_rule(
    rule_id: str,
    org: OrgContext = Depends(get_current_org),
):
    rule = await _get_org_rule(org.org_id, rule_id)
    return _serialize(rule)


async def submit_rule_for_review(org_id: str, user_id: str, rule: dict[str, Any]) -> dict[str, Any]:
    """The draft -> in_review flip behind POST /{rule_id}/submit below —
    pulled out so workers/tasks_contradictions.py's nightly contradiction
    sweep (which finds rules that contradict each other and opens a PR
    proposing how to resolve it) can push a proposed-resolution draft it
    just created through the exact same status transition a human
    submitting a rule through the API gets, without duplicating the
    put_rule/audit sequence.
    Raises ValueError (not HTTPException — this has no request/response of
    its own) if `rule` isn't a draft; the HTTP endpoint below translates
    that into its usual 400."""
    if rule["status"] != "draft":
        raise ValueError(f"rule is '{rule['status']}', not draft")

    before = dict(rule)
    rule["status"] = "in_review"
    await put_rule(rule)
    await append_audit(
        org_id=org_id,
        rule_slug=rule["slug"],
        actor_id=user_id,
        action="submitted",
        before=before,
        after=rule,
    )
    return rule


@router.post("/{rule_id}/submit")
async def submit_rule(
    rule_id: str,
    org: OrgContext = Depends(get_current_org),
):
    rule = await _get_org_rule(org.org_id, rule_id)
    try:
        rule = await submit_rule_for_review(org.org_id, org.user_id, rule)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _serialize(rule)


# propose_rule_for_org's default PR intro — pulled to a module constant so
# workers/tasks_contradictions.py's nightly contradiction sweep can reuse
# it verbatim for the parts of a proposed-resolution PR that
# aren't specific to why the sweep opened it (see that module's own
# pr_intro override for the sweep-specific framing it prepends instead).
_DEFAULT_PROPOSE_PR_INTRO = "Opened by `gnt review` — merging this PR approves the rule."


async def propose_rule_for_org(
    org_id: str,
    user_id: str,
    rule: dict[str, Any],
    connection: GithubConnection,
    pat: str,
    session: AsyncSession,
    *,
    pr_title: str | None = None,
    pr_intro: str = _DEFAULT_PROPOSE_PR_INTRO,
) -> tuple[dict[str, Any], PullRequestResult]:
    """The branch/file/PR-opening core behind POST /{rule_id}/propose below
    — pulled out so workers/tasks_contradictions.py's nightly contradiction
    sweep can push a proposed-resolution draft it just created
    (via create_rule_amendment + submit_rule_for_review above) through the
    exact same submit-then-propose lifecycle a human editing a rule through
    the API gets, rather than reimplementing the branch/file/PR mechanics a
    second time. `rule` must already be status=='in_review' — caller's job
    to check first, same convention every other _get_org_rule caller in
    this file already follows.

    pr_title/pr_intro let a caller other than the human-facing endpoint
    below override the parts of the PR that explain *why* it exists (the
    sweep's own PR explains the contradiction it's resolving, not "Opened
    by `gnt review`") while keeping the source/confidence/conflict-warning
    body every proposed PR already carries.

    Raises GithubClientError, unlike the endpoint below, if GitHub rejects
    any step — translating that into a response shape (a 422, a caught
    exception folded into a worker's own per-item failure handling) is the
    caller's job, not this function's. Returns (rule, pr) — the caller
    still holds the now-pending_merge rule dict and the PullRequestResult
    for whatever it needs next (serializing a response, recording a PR
    number in its own dedup table)."""
    before = dict(rule)
    # A unique suffix per attempt — reusing one fixed branch name across
    # propose calls (e.g. reject then re-propose after an edit) would hit
    # create_branch's idempotent "already exists" path and silently reuse a
    # stale branch pointing at whatever base commit the FIRST attempt saw,
    # serving outdated content instead of the current rule state.
    branch = f"gnt/propose-{_bare_id(rule['slug'])}-{uuid.uuid4().hex[:8]}"
    path = f"rules/{_bare_id(rule['slug'])}.md"
    # Render with pending_merge already reflected — the PR being proposed
    # IS what pending_merge means, even before its own number/url are known
    # (those get set below, once open_pull_request returns).
    rule["status"] = "pending_merge"
    markdown = render_rule_markdown(_serialize(rule))
    pr_body = pr_intro
    # Put the source right in the PR description, not just the file's
    # frontmatter — the whole point is a reviewer checking a rule against
    # its source in seconds, without opening the diff. Silently omitted
    # (not a placeholder like "no source on file") when the rule doesn't
    # have one, since plenty of legitimate rules won't.
    if rule.get("source"):
        pr_body += f"\n\n**Source:** {rule['source']}"
    # Confidence is a model-assigned estimate, never
    # independently verified, and the PR body is the one confidence
    # surface `gnt review`'s own labeling (theme.ts's confidenceColor)
    # can't reach: a reviewer merges this PR on GitHub, not in the
    # terminal, so this is the only place that reviewer ever sees it.
    # Always present, unlike Source above, since every rule has a
    # confidence value.
    pr_body += (
        f"\n\n**Confidence:** {round(rule['confidence'] * 100)}% "
        "(model-assigned estimate — not a verified fact)"
    )
    conflict = await find_conflict(org_id, rule)
    if conflict is not None:
        # Soft gate only — this never blocks the PR from opening, it just
        # makes sure the human merging it sees it. See
        # pipeline/rule_conflict.py's module docstring for why there's no
        # blocking equivalent of the old decision_rules pipeline's
        # RuleReviewCase here.
        pr_body = (
            f"⚠️ **Possible conflict ({conflict['relation']}) with `{conflict['title']}`** "
            f"({conflict['slug']}): {conflict['explanation']}\n\n{pr_body}"
        )

    await create_branch(connection.repo_url, pat, branch, connection.default_branch)
    await put_file(connection.repo_url, pat, branch, path, markdown, f"propose: {rule['title']}")
    pr = await open_pull_request(
        connection.repo_url,
        pat,
        branch,
        connection.default_branch,
        title=pr_title or f"Propose rule: {rule['title']}",
        body=pr_body,
    )

    rule["prNumber"] = pr.number
    rule["prUrl"] = pr.url
    await put_rule(rule)
    await append_audit(
        org_id=org_id,
        rule_slug=rule["slug"],
        actor_id=user_id,
        action="proposed",
        before=before,
        after=rule,
    )
    await log_onboarding_event(session, org_id, "rule_proposed")
    if conflict is not None:
        await log_conflict_flagged(session, org_id, rule["slug"], pr.number, conflict)
    return rule, pr


@router.post("/{rule_id}/propose")
async def propose_rule(
    rule_id: str,
    org: OrgContext = Depends(require_entitled_admin),
    session: AsyncSession = Depends(get_session),
):
    """Renders the rule to markdown and opens a PR against the org's
    connected repo. This is `approve`'s replacement — approval now means a
    human merging that PR on GitHub, not an in-terminal keypress (see
    docs/migration/RECONCILE_V2.md). The actual approved-status transition,
    including the HMAC-signed write and the previous-version supersede
    dance approve_rule used to do here, happens in the webhook handler
    once a real merge is confirmed — this endpoint only ever writes
    `pending_merge`, never `approved`, so none of that machinery belongs
    in this function anymore."""
    rule = await _get_org_rule(org.org_id, rule_id)
    if rule["status"] != "in_review":
        raise HTTPException(status_code=400, detail=f"rule is '{rule['status']}', not in_review")

    connection = (
        await session.execute(select(GithubConnection).where(GithubConnection.org_id == org.org_id))
    ).scalar_one_or_none()
    if connection is None:
        raise HTTPException(
            status_code=409, detail="no GitHub repo connected — run `gnt connect github` first"
        )

    try:
        pat = await get_repo_token(connection)
        rule, _pr = await propose_rule_for_org(org.org_id, org.user_id, rule, connection, pat, session)
    except (GithubClientError, GithubAppError) as exc:
        # 422, not 502 -- matches routers/github.py's connect_github, which
        # treats the same exception type the same way. GithubClientError
        # means GitHub answered and told us the connected repo isn't in a
        # state we can use (no commits yet, PAT lost access, branch
        # deleted) -- that's the customer's repo, not our gateway being
        # down, so a 502 misleads whoever's debugging this into thinking
        # it's transient infra rather than something to fix on their end.
        # GithubAppError (an App-connected org's installation token mint
        # failing) gets the same treatment for the same reason.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _serialize(rule)


def _batch_pr_title(rules: list[dict[str, Any]]) -> str:
    """Keeps the PR title readable regardless of batch size — batch-propose
    groups 5-8 rules per PR by topic (see config.py's
    max_rules_per_batch_propose), and spelling out 8 full titles in a
    GitHub PR title would be unreadable long before that ceiling."""
    titles = [rule["title"] for rule in rules]
    if len(titles) <= 3:
        return f"Propose {len(titles)} rules: {', '.join(titles)}"
    return f"Propose {len(titles)} rules: {', '.join(titles[:3])}, +{len(titles) - 3} more"


def _batch_pr_section(rule: dict[str, Any], conflict: dict[str, Any] | None) -> str:
    """One rule's block within a multi-rule PR body — same fields
    propose_rule already surfaces for a single rule (conflict warning,
    source, confidence), just per-rule inside the batch instead of once
    for the whole PR, so a reviewer scanning the description before
    opening the diff can see where every rule in the batch came from."""
    lines = [f"### {rule['title']}"]
    if conflict is not None:
        # Soft gate only, same as propose_rule's — never blocks the PR,
        # just makes sure the human merging it sees it for THIS rule.
        lines.append(
            f"⚠️ **Possible conflict ({conflict['relation']}) with `{conflict['title']}`** "
            f"({conflict['slug']}): {conflict['explanation']}"
        )
    if rule.get("source"):
        lines.append(f"**Source:** {rule['source']}")
    lines.append(
        f"**Confidence:** {round(rule['confidence'] * 100)}% "
        "(model-assigned estimate — not a verified fact)"
    )
    return "\n".join(lines)


@router.post("/batch-propose")
async def batch_propose_rules(
    body: BatchProposeRequest,
    org: OrgContext = Depends(require_entitled_admin),
    session: AsyncSession = Depends(get_session),
):
    """propose_rule's batched sibling — one branch, one
    put_file per rule, ONE pull request for the whole batch, and every
    rule in it moves to pending_merge together carrying the SAME
    prNumber/prUrl. Built for `gnt prebrain`'s draft-rule output (5-8
    related rules reviewed as one PR), but not restricted to that caller.

    Validation fails the WHOLE batch with a clear error naming the
    offending rule(s) rather than silently skipping or partially
    processing — a batch is one reviewable unit; a caller that asked for
    5 rules and silently got 3 proposed has no way to know that happened
    short of diffing IDs itself. Nothing GitHub-side happens until every
    rule in the batch has already passed validation.
    """
    settings = get_settings()
    if len(body.rule_ids) > settings.max_rules_per_batch_propose:
        raise HTTPException(
            status_code=422,
            detail=(
                f"batch-propose accepts at most {settings.max_rules_per_batch_propose} rules "
                f"per call (got {len(body.rule_ids)})"
            ),
        )
    if len(set(body.rule_ids)) != len(body.rule_ids):
        raise HTTPException(status_code=422, detail="batch-propose received duplicate rule ids")

    # Tenant isolation, same as _get_org_rule (store_get_rule is itself
    # org-scoped) — a rule id belonging to another org 404s exactly like a
    # single-rule lookup would, not a silent skip. Fetched (and validated)
    # in full before any GitHub call, so a bad id anywhere in the batch
    # never leaves a half-opened PR behind.
    rules: list[dict[str, Any]] = []
    for rule_id in body.rule_ids:
        rule = await store_get_rule(org.org_id, _slug(rule_id))
        if rule is None:
            raise HTTPException(status_code=404, detail=f"rule not found: {rule_id}")
        rules.append(rule)

    not_in_review = [_bare_id(rule["slug"]) for rule in rules if rule["status"] != "in_review"]
    if not_in_review:
        raise HTTPException(
            status_code=400,
            detail=f"rule(s) not in_review: {', '.join(not_in_review)}",
        )

    connection = (
        await session.execute(select(GithubConnection).where(GithubConnection.org_id == org.org_id))
    ).scalar_one_or_none()
    if connection is None:
        raise HTTPException(
            status_code=409, detail="no GitHub repo connected — run `gnt connect github` first"
        )

    befores = [dict(rule) for rule in rules]
    # One branch for the whole batch, unlike propose_rule's per-rule
    # branch — this IS the "one PR, several files" shape the batch exists
    # for. Same uuid-suffix reasoning as propose_rule: a retried
    # batch-propose call must not silently reuse a stale branch from a
    # first attempt.
    branch = f"gnt/batch-propose-{uuid.uuid4().hex[:8]}"

    for rule in rules:
        rule["status"] = "pending_merge"

    conflicts: dict[str, dict[str, Any]] = {}
    for rule in rules:
        conflict = await find_conflict(org.org_id, rule)
        if conflict is not None:
            conflicts[rule["slug"]] = conflict

    pr_title = _batch_pr_title(rules)
    pr_intro = f"Opened by `gnt prebrain` — merging this PR approves {len(rules)} rules together."
    pr_body = "\n\n".join(
        [pr_intro] + [_batch_pr_section(rule, conflicts.get(rule["slug"])) for rule in rules]
    )

    try:
        pat = await get_repo_token(connection)
        await create_branch(connection.repo_url, pat, branch, connection.default_branch)
        for rule in rules:
            path = f"rules/{_bare_id(rule['slug'])}.md"
            markdown = render_rule_markdown(_serialize(rule))
            await put_file(connection.repo_url, pat, branch, path, markdown, f"propose: {rule['title']}")
        pr = await open_pull_request(
            connection.repo_url,
            pat,
            branch,
            connection.default_branch,
            title=pr_title,
            body=pr_body,
        )
    except (GithubClientError, GithubAppError) as exc:
        # 422, not 502 — same reasoning as propose_rule: GitHub answered
        # and told us the connected repo isn't in a usable state, which is
        # the customer's repo, not gnt's gateway, being the problem. An
        # App-connected org whose installation token mint itself failed
        # (GithubAppError) gets the same treatment — either way, the
        # customer's own connection is what needs fixing, not gnt's infra.
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    for rule, before in zip(rules, befores, strict=True):
        rule["prNumber"] = pr.number
        rule["prUrl"] = pr.url
        await put_rule(rule)
        await append_audit(
            org_id=org.org_id,
            rule_slug=rule["slug"],
            actor_id=org.user_id,
            action="proposed",
            before=before,
            after=rule,
        )
        # Mirrors propose_rule's own per-rule side effects (onboarding
        # event, conflict-flagged calibration event) for every rule in the
        # batch, not just once for the group — the same calibration/
        # onboarding signal propose_rule already records per proposed
        # rule, and log_onboarding_event/log_conflict_flagged are both
        # cheap, best-effort, append-only writes with no per-org
        # dedup semantics that would make firing N times for N rules
        # wrong.
        await log_onboarding_event(session, org.org_id, "rule_proposed")
        conflict = conflicts.get(rule["slug"])
        if conflict is not None:
            await log_conflict_flagged(session, org.org_id, rule["slug"], pr.number, conflict)

    return {
        "pr_number": pr.number,
        "pr_url": pr.url,
        "rules": [_serialize(rule) for rule in rules],
    }


@router.post("/{rule_id}/reject")
async def reject_rule(
    rule_id: str,
    body: RejectRuleRequest,
    org: OrgContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    rule = await _get_org_rule(org.org_id, rule_id)
    if rule["status"] not in ("in_review", "pending_merge"):
        raise HTTPException(
            status_code=400,
            detail=f"rule is '{rule['status']}', not in_review or pending_merge",
        )

    before = dict(rule)
    if rule["status"] == "pending_merge" and rule.get("prNumber"):
        connection = (
            await session.execute(select(GithubConnection).where(GithubConnection.org_id == org.org_id))
        ).scalar_one_or_none()
        if connection is not None:
            try:
                pat = await get_repo_token(connection)
                await close_pull_request(connection.repo_url, pat, rule["prNumber"])
            except (GithubClientError, GithubAppError):
                # Best-effort — GitHub being unreachable shouldn't block a
                # rejection the user is doing locally. Worst case is a stale
                # open PR a human has to close by hand.
                pass

    rule["status"] = "draft"
    rule["prNumber"] = None
    rule["prUrl"] = None
    await put_rule(rule)
    after = dict(rule)
    if body.reason:
        after["rejectionReason"] = sanitize(body.reason)
    await append_audit(
        org_id=org.org_id,
        rule_slug=rule["slug"],
        actor_id=org.user_id,
        action="rejected",
        before=before,
        after=after,
    )
    return _serialize(rule)


@router.post("/{rule_id}/deprecate")
async def deprecate_rule(
    rule_id: str,
    org: OrgContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
):
    rule = await _get_org_rule(org.org_id, rule_id)
    if rule["status"] == "deprecated":
        raise HTTPException(status_code=400, detail="rule is already deprecated")

    before = dict(rule)
    rule["status"] = "deprecated"
    await put_rule(rule)
    await append_audit(
        org_id=org.org_id,
        rule_slug=rule["slug"],
        actor_id=org.user_id,
        action="deprecated",
        before=before,
        after=rule,
    )
    # Calibration data — before, not rule: age is
    # measured off the rule as it stood right before this deprecation,
    # same object log_revalidation_if_previously_stale below checks.
    await log_deprecation(session, org.org_id, before)
    await log_revalidation_if_previously_stale(session, org.org_id, rule["slug"], "deprecated")
    return _serialize(rule)


async def create_rule_amendment(
    org_id: str,
    user_id: str,
    current: dict[str, Any],
    body: CreateRuleRequest,
    session: AsyncSession,
) -> dict[str, Any]:
    """The actual new-draft-version-of-an-approved-rule logic behind POST
    /{rule_id}/edit below — pulled out, same reasoning as create_draft_rule
    above, so workers/tasks_contradictions.py's nightly contradiction
    sweep can create the exact same shape of amendment draft a
    human editing an approved rule through the API would — new slug, new
    draft row, previousVersionId pointing at `current`, version bumped by
    one — through a completely different caller (a nightly cron job, not
    get_current_org), without duplicating the sanitize/new-version-dict/
    put_rule/audit sequence. Caller is responsible for confirming
    `current["status"] == "approved"` first, same convention every other
    _get_org_rule caller in this file already follows — this function only
    ever writes the new draft row, never touches `current` itself."""
    title = sanitize(body.title)
    rule_body = sanitize(body.body)
    source = sanitize(body.source) if body.source else None
    now = datetime.now(timezone.utc).isoformat()
    new_version = {
        "slug": _slug(str(uuid.uuid4())),
        "org": org_id,
        "title": title,
        "body": rule_body,
        "status": "draft",
        "confidence": body.confidence,
        "ownerId": user_id,
        "sourceCitations": body.source_citations,
        "source": source,
        "tags": body.tags,
        "lastValidatedAt": None,
        "version": current["version"] + 1,
        "supersededBy": None,
        "previousVersionId": current["slug"],
        "approvedBy": None,
        "approvedAt": None,
        "createdAt": now,
        "prNumber": None,
        "prUrl": None,
    }
    await put_rule(new_version)
    await append_audit(
        org_id=org_id,
        rule_slug=new_version["slug"],
        actor_id=user_id,
        action="created",
        before=None,
        after=new_version,
    )
    # Calibration data — current, the rule this edit
    # is superseding, not new_version, which was never in RuleStaleness's
    # snapshot to begin with.
    await log_revalidation_if_previously_stale(session, org_id, current["slug"], "edited")
    return new_version


@router.post("/{rule_id}/edit", status_code=201)
async def edit_rule(
    rule_id: str,
    body: CreateRuleRequest,
    org: OrgContext = Depends(get_current_org),
    session: AsyncSession = Depends(get_session),
):
    """Creates a new draft version of an approved rule. The old rule stays
    exactly as-is (still approved, still served) until the new version
    is itself approved — see approve_rule's supersede step."""
    current = await _get_org_rule(org.org_id, rule_id)
    if current["status"] != "approved":
        raise HTTPException(
            status_code=400,
            detail=f"rule is '{current['status']}' — only approved rules go through /edit",
        )

    new_version = await create_rule_amendment(org.org_id, org.user_id, current, body, session)
    return _serialize(new_version)

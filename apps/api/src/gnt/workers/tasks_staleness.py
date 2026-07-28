"""Nightly per-rule staleness computation (fix-plan-v2 item 9 — staleness
surfaced at serving time). See gnt.staleness for the decay math this
reuses (resurrected from the retired decay_confidence job) and its own
docstring for why it's one flat lambda instead of the old per-type table.

This establishes the enumerate-orgs-then-scope-each pattern any other
cron job added to worker.py's cron_jobs list should follow (see that
list's own comment): reads the list of org ids through gnt_cron
(BYPASSRLS), the same narrow "the org itself is RLS-protected and
there's no other way to enumerate it before you're scoped to one"
exemption db/session.py's get_cron_session docstring already carves out
for the billing webhook — then every actual per-org read (the store call)
and write (this table) goes through a normal scope_to_org'd session/call,
one org at a time, never a single cross-org statement.

That last part is a deliberate departure from the job this resurrects:
the retired decay_confidence ran one bulk cross-org UPDATE under
BYPASSRLS, which was fine when it was written (RLS didn't enforce yet)
but is exactly the shape of bug real RLS later caught elsewhere — see
routers/billing.py's webhook handler and
test_billing.py::test_webhook_requires_a_bypassrls_session_not_the_
ordinary_one, where an unscoped gnt_app session silently matched zero
rows instead of writing anything. A cross-org statement either needs
BYPASSRLS (too broad a hammer for routine per-org application writes) or
silently no-ops under RLS. Looping per-org through a normal scoped
session avoids both failure modes.

fix-plan-v3 3.2 (staleness-sweep half) extends this from purely passive
flagging to acting on staleness where there's something concrete to act
on. "Where available" is narrow on purpose: most rules have nothing
re-checkable — starter-pack rules, webhook-ingested rules, and hand-typed
rules all lack a pointer back to a specific file in the customer's own
repo. Only `gnt prebrain`-extracted rules carry source_citations
(routers/rules.py's CreateRuleRequest.source_citations, a plain
list[dict] with no fixed sub-schema — see apps/cli/src/prebrain/
extraction/types.ts's SourceCitation for the shape each entry actually
has: sourcePath, startLine, endLine, walker, excerpt) pointing at a real
path in the org's connected GitHub repo. That's the "fresh source
material" this sweep can actually re-check: does the org have a
GithubConnection, does the stale rule have a qualifying citation (a
sourcePath plus walker "repo-scan" or "docs-dir" — not "notion-export",
a Notion export isn't a live, re-fetchable GitHub path), and has that
file's current content (get_file_content, the same function
github_webhook.py already uses to read a merged file) drifted from what
the citation's own excerpt captured at extraction time.

This deliberately does NOT re-extract or rewrite a rule's body — that's
a CLI-only, model-backed pipeline (apps/cli/src/prebrain/extraction/)
this codebase has no server-side port of, and porting it is out of
scope. Instead, both outcomes below (source changed, source gone)
propose the exact same kind of artifact: a new draft version of the rule
(the same edit-then-propose mechanism routers/rules.py's edit_rule
triggers by hand) with a clear, human-readable flag appended to the
body, walked through submit -> propose so a real PR opens on the org's
repo — a human still has to merge it, same as the sibling contradiction
sweep (workers/tasks_contradictions.py) never auto-resolves what it
finds. This module never calls deprecate_rule; "deprecate" here is a
flag message on this one mechanism, not a different code path.

gnt.staleness_refresh is this sweep's own dedup log (mirrors
gnt.contradiction_findings for the sibling sweep) — content_fingerprint
keys on the actual comparison basis, not just "this rule was already
flagged once", so a source that keeps drifting before a human reviews
the first proposal produces a fresh finding instead of being silently
suppressed forever. See _fingerprint below.
"""

import hashlib
import uuid
from datetime import datetime, timezone
from typing import Any

import sentry_sdk
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.db.models import GithubConnection, Org, RuleStaleness
from gnt.db.rls import scope_to_org
from gnt.db.session import get_cron_sessionmaker, get_sessionmaker
from gnt.github.app_auth import GithubAppError, get_repo_token
from gnt.github.client import (
    GithubClientError,
    create_branch,
    get_file_content,
    open_pull_request,
    put_file,
)
from gnt.github.render import render_rule_markdown
from gnt.pipeline.sanitize import sanitize
from gnt.routers.rules import _bare_id, _serialize, _slug
from gnt.staleness import age_days, freshness_score, is_stale
from gnt.staleness_refresh import has_been_proposed, record_proposal
from gnt.store_client import append_audit, put_rule
from gnt.store_client import list_rules as store_list_rules

# Same-role, cross-worker actor id convention as github_webhook.py's
# f"github:{merger_login}" — a namespaced string identifying this as an
# automated write, not a human user id, since RuleAuditLog.actor_user_id
# has no separate "system" concept of its own.
_SWEEP_ACTOR_ID = "gnt:staleness-sweep"

# See this module's own docstring — a Notion export has no live,
# re-fetchable GitHub path to check, so it never qualifies as "fresh
# source material" the way a repo-scan or docs-dir citation does.
_QUALIFYING_WALKERS = {"repo-scan", "docs-dir"}


async def compute_rule_staleness(ctx: dict[str, Any]) -> None:
    """arq cron entrypoint (see worker.py's cron_jobs). Enumerates every
    org, then computes and persists that org's own staleness snapshot —
    see module docstring for why enumeration and the per-org work use two
    different sessions/roles."""
    cron_session_factory = get_cron_sessionmaker()
    async with cron_session_factory() as session:
        org_ids = [row[0] for row in (await session.execute(select(Org.id))).all()]

    for org_id in org_ids:
        # One org's failure (a store outage, a bad GitHub token, an
        # unexpected exception anywhere in this org's own snapshot/refresh
        # work) must never take down the rest of the night's orgs — same
        # per-org isolation tasks_zendesk.py/tasks_intercom.py already give
        # their own sync loops.
        try:
            await compute_staleness_for_org(org_id)
        except Exception as exc:
            sentry_sdk.capture_exception(exc)


async def compute_staleness_for_org(org_id: str) -> None:
    """The per-org unit of work compute_rule_staleness loops over —
    mirrors tasks_compile.py's compile_skills shape exactly: takes an
    org_id, opens its own scope_to_org'd session, does the work. Fetches
    this org's approved rules from the store first (no session needed for
    that — it's an HTTP call), then hands the computed rows to
    write_staleness_rows for the actual scoped write, the same split
    compile_skills/compile_skill_pack use so the write half stays
    testable against a session a test fixture already controls.

    fix-plan-v3 3.2 — once this org's freshness snapshot is written, hands
    off the rules it just flagged is_stale to sweep_staleness_refresh_for_org
    (a completely separate session/scope of its own — see that function's
    docstring for why), which is where the "act on it" half of this task
    lives. A pure flagging run (no stale rules) skips that call entirely,
    same zero-op result as before this task existed."""
    rules = await store_list_rules(org_id, status="approved")
    rows = _rows_for_rules(org_id, rules)

    session_factory = get_sessionmaker()
    async with session_factory() as session:
        await scope_to_org(session, org_id)
        await write_staleness_rows(session, org_id, rows)
        await session.commit()

    stale_slugs = {row["rule_slug"] for row in rows if row["is_stale"]}
    if stale_slugs:
        stale_rules = [rule for rule in rules if rule["slug"] in stale_slugs]
        await sweep_staleness_refresh_for_org(org_id, stale_rules)


def _rows_for_rules(org_id: str, rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    rows = []
    for rule in rules:
        reference = rule.get("lastValidatedAt") or rule.get("approvedAt")
        if not reference:
            # Shouldn't happen for an approved rule (the webhook always
            # sets approvedAt when it merges one to "approved") — skipped
            # rather than crashing the whole org's run over one bad row.
            continue
        age = age_days(reference, now=now)
        rows.append(
            {
                "org_id": org_id,
                "rule_slug": rule["slug"],
                "title": rule["title"],
                "age_days": age,
                "freshness_score": freshness_score(age),
                "is_stale": is_stale(age),
                "computed_at": now,
            }
        )
    return rows


async def write_staleness_rows(session: AsyncSession, org_id: str, rows: list[dict[str, Any]]) -> None:
    """Upserts `rows` (one per currently-approved rule, see
    _rows_for_rules) into rule_staleness and deletes any existing row for
    this org that isn't in `rows` — a full resync each run, not an
    incremental update, so a rule that's stopped being approved
    (deprecated, superseded by a newer edit) disappears from `gnt stale`
    too instead of sitting there with a permanently stale snapshot. Does
    not commit — callers own the transaction, same convention
    gap_tracking.log_gap's caller-commits split doesn't follow but
    compile_skill_pack's session-taking shape does."""
    current_slugs = {row["rule_slug"] for row in rows}

    stale_rows_stmt = delete(RuleStaleness).where(RuleStaleness.org_id == org_id)
    if current_slugs:
        stale_rows_stmt = stale_rows_stmt.where(RuleStaleness.rule_slug.notin_(current_slugs))
    await session.execute(stale_rows_stmt)

    for row in rows:
        stmt = insert(RuleStaleness).values(**row)
        stmt = stmt.on_conflict_do_update(
            index_elements=["org_id", "rule_slug"],
            set_={
                "title": stmt.excluded.title,
                "age_days": stmt.excluded.age_days,
                "freshness_score": stmt.excluded.freshness_score,
                "is_stale": stmt.excluded.is_stale,
                "computed_at": stmt.excluded.computed_at,
            },
        )
        await session.execute(stmt)


# --- fix-plan-v3 3.2: act on staleness where there's something concrete
# to act on ------------------------------------------------------------


def _first_qualifying_citation(rule: dict[str, Any]) -> dict[str, Any] | None:
    """The first source_citations entry (list order, deterministic) this
    sweep can actually re-check against a live GitHub path — see this
    module's own docstring on why only repo-scan/docs-dir citations with a
    sourcePath qualify. A rule with no qualifying citation (starter-pack,
    webhook-ingested, hand-typed, or notion-export-only) gets no action
    here, exactly today's pre-3.2 behavior."""
    for citation in rule.get("sourceCitations") or []:
        if not isinstance(citation, dict):
            continue
        source_path = citation.get("sourcePath")
        if isinstance(source_path, str) and source_path and citation.get("walker") in _QUALIFYING_WALKERS:
            return citation
    return None


def _normalize_for_compare(text: str) -> str:
    return " ".join(text.split())


def _excerpt_drifted(excerpt: str, current_content: str) -> bool:
    """True if the citation's captured excerpt is no longer found
    verbatim (modulo whitespace) inside the file's current content — the
    signal this sweep uses to decide a "refresh" flag is warranted rather
    than leaving a merely-old-but-unchanged rule alone."""
    return _normalize_for_compare(excerpt) not in _normalize_for_compare(current_content)


def _fingerprint(*parts: str) -> str:
    """Deterministic dedup key for gnt.staleness_refresh — see that
    module's docstring for why this, not just (org_id, rule_slug, reason),
    is the actual dedup key: a source that drifts again before a human
    reviews the first proposal should produce a fresh finding, not get
    silently absorbed by it."""
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


def _refresh_note(source_path: str, walker: str, excerpt: str, current_content: str) -> str:
    # Matches tasks_contradictions.py's _issue_body voice: state what
    # changed, be explicit this is automated and unverified, tell the
    # human exactly what their options are.
    truncated = current_content if len(current_content) <= 2000 else current_content[:2000] + "…"
    return (
        "**Staleness sweep flag — source may have changed.** Appended automatically by "
        "gnt's nightly staleness sweep (fix-plan-v3 3.2) — a human needs to review this. "
        "This edit doesn't rewrite the rule's substance; it only appends this note so the "
        "source drift is visible before anyone merges.\n\n"
        f"**Source:** `{source_path}` (walker: `{walker}`)\n\n"
        f"**Captured excerpt (at extraction time):**\n> {excerpt}\n\n"
        f"**Current file content:**\n> {truncated}\n\n"
        "Review the rule against the file's current content and either hand-edit the body "
        "above, deprecate this rule, or reject this draft if it turns out to be a false alarm."
    )


def _deprecate_note(source_path: str, walker: str) -> str:
    return (
        "**Staleness sweep flag — source no longer exists.** Appended automatically by "
        "gnt's nightly staleness sweep (fix-plan-v3 3.2) — a human needs to review this. "
        "This edit doesn't rewrite the rule's substance; it only appends this note.\n\n"
        f"**Source:** `{source_path}` (walker: `{walker}`) — file not found at this path anymore.\n\n"
        "Review whether this rule still holds without its original source and either "
        "deprecate it, hand-edit this draft to point at wherever the content moved, or "
        "reject this draft if it turns out not to be a real issue."
    )


def _pr_title(reason: str, rule_title: str) -> str:
    verb = "Refresh check" if reason == "refresh" else "Deprecate check"
    return f"{verb}: {rule_title}"


def _pr_body(note: str) -> str:
    return (
        "Opened automatically by gnt's nightly staleness sweep (fix-plan-v3 3.2) — a human "
        "needs to review this. Nothing about this PR changes the rule's status on its own; "
        "merging it only ever approves this new draft version, the same as merging any other "
        "proposed rule.\n\n" + note
    )


async def sweep_staleness_refresh_for_org(org_id: str, stale_rules: list[dict[str, Any]]) -> None:
    """The per-org unit of work compute_staleness_for_org hands its
    is_stale rules to. Opens its own scope_to_org'd session — deliberately
    separate from the session write_staleness_rows already committed and
    closed, the same "one session per unit of work" shape
    sweep_contradictions_for_org uses relative to compute_staleness_for_org
    itself.

    An org with no connected GitHub repo has nowhere to open a PR, so it's
    skipped outright — not an error, exactly today's (pre-3.2) behavior
    for every org without one."""
    if not stale_rules:
        return

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
            # An App-connected org whose installation token mint fails
            # (revoked mid-sweep, GitHub outage) has nowhere to open a PR
            # tonight, same as "no connection at all" above — not this
            # sweep's job to retry, the nightly cron just runs again
            # tomorrow.
            sentry_sdk.capture_exception(exc)
            return

        for rule in stale_rules:
            await _process_stale_rule(session, org_id, connection, pat, rule)


async def _process_stale_rule(
    session: AsyncSession,
    org_id: str,
    connection: GithubConnection,
    pat: str,
    rule: dict[str, Any],
) -> None:
    """One stale rule's refresh-or-deprecate check, start to finish.
    Wrapped in one broad except — the same "one bad item never derails
    the rest of the run" discipline tasks_contradictions.py's
    _process_pair applies to its own per-pair loop: a fetch failure, a
    malformed citation, or a GitHub error here skips this one rule, never
    the rest of the org's nightly sweep."""
    try:
        citation = _first_qualifying_citation(rule)
        if citation is None:
            return
        source_path = citation["sourcePath"]
        walker = citation.get("walker", "")
        excerpt = citation.get("excerpt") or ""

        try:
            content = await get_file_content(
                connection.repo_url, pat, source_path, connection.default_branch
            )
        except GithubClientError as exc:
            if exc.status_code == 404:
                await _propose_flag(
                    session,
                    org_id,
                    connection,
                    pat,
                    rule,
                    reason="deprecate",
                    source_path=source_path,
                    note=_deprecate_note(source_path, walker),
                    fingerprint=_fingerprint("deprecate", source_path),
                )
            # Any other GithubClientError (network hiccup, auth issue,
            # rate limit) is an ordinary per-rule failure, not evidence
            # the source is gone — skip this rule, no false "deprecate".
            return

        if not excerpt.strip():
            # No captured baseline to compare against — can't claim the
            # source has "meaningfully diverged" with nothing to diff it
            # against, so this citation is left alone rather than guessed
            # at.
            return

        # Sanitize discipline on anything composed from the refetched
        # file's current content (and the stored excerpt, itself
        # customer-repo-derived) before either lands in a proposed rule
        # body or PR text.
        content = sanitize(content)
        excerpt_clean = sanitize(excerpt)
        if not _excerpt_drifted(excerpt_clean, content):
            return  # source hasn't actually changed — nothing to flag

        await _propose_flag(
            session,
            org_id,
            connection,
            pat,
            rule,
            reason="refresh",
            source_path=source_path,
            note=_refresh_note(source_path, walker, excerpt_clean, content),
            fingerprint=_fingerprint("refresh", source_path, content),
        )
    except Exception as exc:
        sentry_sdk.capture_exception(exc)


async def _propose_flag(
    session: AsyncSession,
    org_id: str,
    connection: GithubConnection,
    pat: str,
    rule: dict[str, Any],
    *,
    reason: str,
    source_path: str,
    note: str,
    fingerprint: str,
) -> None:
    """Dedup-gated. Builds a new draft version of `rule` — the exact same
    shape routers/rules.py's edit_rule creates by hand (status draft,
    previousVersionId pointing at the current approved rule, version + 1)
    — with `note` appended to its body, then walks it through the same
    submit -> propose transitions a human triggers from the CLI/API,
    opening a real PR the org's connected repo. Never calls deprecate_rule
    or otherwise writes the ORIGINAL rule's status — the original stays
    approved and serving exactly as-is until a human merges (or doesn't)
    this proposal, same as edit_rule's own documented behavior."""
    if await has_been_proposed(session, org_id, rule["slug"], reason, fingerprint):
        return

    now = datetime.now(timezone.utc).isoformat()
    new_version: dict[str, Any] = {
        "slug": _slug(str(uuid.uuid4())),
        "org": org_id,
        "title": rule["title"],
        "body": rule["body"] + "\n\n---\n\n" + note,
        "status": "draft",
        "confidence": rule["confidence"],
        "ownerId": rule["ownerId"],
        "sourceCitations": rule["sourceCitations"],
        "source": rule.get("source"),
        "tags": rule["tags"],
        "lastValidatedAt": None,
        "version": rule["version"] + 1,
        "supersededBy": None,
        "previousVersionId": rule["slug"],
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
        actor_id=_SWEEP_ACTOR_ID,
        action="created",
        before=None,
        after=new_version,
    )

    new_version["status"] = "in_review"
    await put_rule(new_version)
    await append_audit(
        org_id=org_id,
        rule_slug=new_version["slug"],
        actor_id=_SWEEP_ACTOR_ID,
        action="submitted",
        before=None,
        after=new_version,
    )

    branch = f"gnt/staleness-{reason}-{uuid.uuid4().hex[:8]}"
    new_version["status"] = "pending_merge"
    path = f"rules/{_bare_id(new_version['slug'])}.md"
    markdown = render_rule_markdown(_serialize(new_version))

    # A failed PR open leaves the draft sitting in pending_merge, same as
    # propose_rule's own failure mode — not recorded in the dedup table
    # (record_proposal only ever runs once a real PR exists), so the next
    # run tries again fresh rather than silently giving up on this rule.
    await create_branch(connection.repo_url, pat, branch, connection.default_branch)
    await put_file(
        connection.repo_url,
        pat,
        branch,
        path,
        markdown,
        f"staleness sweep: {reason} — {rule['title']}",
    )
    pr = await open_pull_request(
        connection.repo_url,
        pat,
        branch,
        connection.default_branch,
        title=_pr_title(reason, rule["title"]),
        body=_pr_body(note),
    )

    new_version["prNumber"] = pr.number
    new_version["prUrl"] = pr.url
    await put_rule(new_version)
    await append_audit(
        org_id=org_id,
        rule_slug=new_version["slug"],
        actor_id=_SWEEP_ACTOR_ID,
        action="proposed",
        before=None,
        after=new_version,
    )

    await record_proposal(
        session,
        org_id,
        rule["slug"],
        reason=reason,
        source_path=source_path,
        content_fingerprint=fingerprint,
        new_rule_slug=new_version["slug"],
        pr_number=pr.number,
        pr_url=pr.url,
    )

import hashlib
import hmac
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.approval import hash_approval_content, sign_approval
from gnt.calibration import log_conflict_override_if_flagged
from gnt.config import get_settings
from gnt.db.models import GithubConnection
from gnt.db.session import get_session
from gnt.github.app_auth import GithubAppError, get_repo_token
from gnt.github.client import GithubClientError, get_file_content
from gnt.github.crypto import decrypt_token
from gnt.github.render import parse_rule_markdown
from gnt.locks import acquire_lock, release_lock
from gnt.onboarding_metrics import log_onboarding_event
from gnt.pipeline.sanitize import sanitize
from gnt.queue import enqueue_compile
from gnt.routers.rules import _bare_id
from gnt.store_client import (
    ApprovalRejected,
    append_audit,
    get_rule as store_get_rule,
    list_rules_by_pr,
    put_rule,
)

# Separate router from routers/github.py on purpose — that one is a
# session-authenticated, admin-gated settings surface; this one has no
# session/API-key auth at all and instead is HMAC-authenticated by
# GitHub itself. Mixing the two trust boundaries in one file would blur
# something worth keeping obviously distinct.
router = APIRouter(prefix="/v1/github", tags=["github-webhook"])

# Fields a human might reasonably edit in the PR diff before merging, and
# that the approval should reflect — never version/supersededBy/
# previousVersionId/ownerId/slug/org/createdAt, which stay authoritative
# from the engine's existing rule state regardless of what the file's
# frontmatter says. A careless or malicious PR edit to previousVersionId,
# say, must never be able to rewrite the version chain. last_validated_at
# is deliberately NOT in this set — approval IS the re-validation event, so
# it always gets stamped to "now" below regardless of what the file says.
_EDITABLE_FROM_FILE = {"confidence", "source_citations", "source", "tags"}


def _verify_signature(secret: str, raw_body: bytes, signature_header: str | None) -> bool:
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header)


@router.post("/webhook")
async def github_webhook(
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    raw_body = await request.body()
    event = request.headers.get("X-GitHub-Event")
    signature = request.headers.get("X-Hub-Signature-256")

    try:
        payload = json.loads(raw_body)
    except ValueError:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    repo_full_name = (payload.get("repository") or {}).get("full_name")
    if not repo_full_name:
        return JSONResponse({"error": "missing repository"}, status_code=400)
    repo_url = f"https://github.com/{repo_full_name}"

    connection = (
        await session.execute(select(GithubConnection).where(GithubConnection.repo_url == repo_url))
    ).scalar_one_or_none()
    if connection is None:
        # Unknown/disconnected repo — 200 so GitHub doesn't keep retrying a
        # delivery gnt has nothing to do with. No secret to check against
        # here, and nothing state-changing happens either way.
        return JSONResponse({"ok": True})

    # App-installed deliveries carry an `installation` object; PAT-flow
    # deliveries never do (there's no App installation behind them). Every
    # App-connected connection is signed with the single, shared
    # GITHUB_APP_WEBHOOK_SECRET (one App, one webhook secret, for every
    # installation of it) rather than connection.webhook_secret_encrypted's
    # per-repo secret — so on its own, a valid signature here only proves
    # "this delivery genuinely came from OUR App", not "for THIS org". The
    # installation_id equality check below is what closes that gap: a
    # payload whose repository resolves to this connection but whose
    # installation_id belongs to a DIFFERENT org's real installation is
    # rejected even though the signature itself checks out (same class of
    # forgery the cross-org PAT-secret test below already covers for the
    # legacy flow — see test_github_webhook.py's
    # test_a_different_installations_real_signature_cannot_forge_this_orgs_approval).
    payload_installation_id = (payload.get("installation") or {}).get("id")
    if connection.installation_id is not None:
        # Fail closed, never fall back to an empty-string secret -- an
        # unset GITHUB_APP_WEBHOOK_SECRET would otherwise make every
        # App-connected org's signature check pass for anyone who knows to
        # sign with an empty key (trivially guessable), silently turning
        # "misconfigured" into "no auth at all" instead of a loud 401.
        app_secret = get_settings().github_app_webhook_secret
        if not app_secret or payload_installation_id != connection.installation_id:
            return JSONResponse({"error": "installation/repo mismatch"}, status_code=401)
        webhook_secret = app_secret
    else:
        # A PAT-only connection has no installation to match against — a
        # payload claiming one anyway is itself a mismatch, not something
        # to fall through and check against the per-repo secret.
        if payload_installation_id is not None:
            return JSONResponse({"error": "installation/repo mismatch"}, status_code=401)
        webhook_secret = decrypt_token(connection.webhook_secret_encrypted)

    if not _verify_signature(webhook_secret, raw_body, signature):
        return JSONResponse({"error": "invalid signature"}, status_code=401)

    if event != "pull_request":
        return JSONResponse({"ok": True})

    pr = payload.get("pull_request") or {}
    if payload.get("action") != "closed" or not pr.get("merged"):
        return JSONResponse({"ok": True})

    pr_number = pr.get("number")
    if not isinstance(pr_number, int):
        return JSONResponse({"ok": True})

    # Plural because batch-propose (routers/rules.py) can
    # put several rules on the SAME merged PR (same prNumber). Each one
    # still gets its own file, its own approval, its own audit trail —
    # this list is just how many of those this one merge event needs to
    # process. Empty list is exactly the old "rule is None" case: an
    # unrelated PR on the same repo, or every rule on this PR already moved
    # past pending_merge (e.g. a duplicate delivery after this handler
    # already ran once). Not an error either way.
    rules = await list_rules_by_pr(connection.org_id, pr_number)
    if not rules:
        return JSONResponse({"ok": True})

    merger_login = (pr.get("merged_by") or {}).get("login") or "unknown"
    actor_id = f"github:{merger_login}"

    # Sequential, not concurrent — matches the pre-batch handler's own
    # single-event-at-a-time shape (no new concurrency introduced here) and
    # keeps per-rule lock acquisition order deterministic within one
    # delivery. Each rule's own outcome is independent: one rule's failure
    # (a bad file, a lock conflict) must not take down its siblings in the
    # same batch — see _approve_one_rule's docstring for the full
    # reasoning behind that design call.
    results = [
        await _approve_one_rule(rule, connection=connection, actor_id=actor_id, pr_number=pr_number, session=session)
        for rule in rules
    ]

    if any(result["status"] == "retry" for result in results):
        # At least one rule in this batch hit a lock conflict (another
        # delivery of the same event mid-flight) — GitHub retries a
        # webhook delivery on a non-2xx response, same convention the
        # pre-batch handler used. This is safe to ask for broadly rather
        # than per-rule: any sibling that already succeeded in this same
        # pass already flipped to "approved" and so will no longer show up
        # in list_rules_by_pr's results on the retried delivery (that
        # status-filtered lookup is what makes redelivery idempotent —
        # see the module docstring above list_rules_by_pr in
        # store_client.py) — so a retry here reprocesses only the rules
        # still actually pending, never redoes already-approved siblings.
        return JSONResponse({"error": "another approval in progress, will retry", "results": results}, status_code=409)

    # "already_superseded" is a clean resolution, not a failure — a rule
    # that lost the double-edit race (see _approve_one_rule's own comment
    # on that check) was correctly left untouched, same as the pre-batch
    # handler's own {"ok": True, "note": "already superseded"} response.
    # Only "error" (a genuinely broken file, a rejected signature) counts
    # against overall_status here.
    resolved_count = sum(1 for result in results if result["status"] in ("approved", "already_superseded"))
    if resolved_count == len(results):
        overall_status = "approved"
    elif resolved_count > 0:
        overall_status = "partial"
    else:
        overall_status = "error"
    # "partial"/"error" get a non-2xx status so GitHub retries the
    # delivery, same as the pre-batch handler's own 502 for an unreadable/
    # unparseable file (a bare `return JSONResponse(...)` here defaults to
    # 200, which would silently drop that retry -- a transient
    # GithubClientError while reading one rule's file deserves the same
    # free automatic retry it got before batching existed). A retry only
    # ever reprocesses what's still actually unresolved: list_rules_by_pr
    # is status-filtered, so any rule this same pass already approved
    # won't come back on the redelivery — see the idempotency reasoning
    # above this function.
    status_code = 200 if overall_status == "approved" else 502
    return JSONResponse({"ok": True, "status": overall_status, "results": results}, status_code=status_code)


async def _approve_one_rule(
    rule: dict,
    *,
    connection: GithubConnection,
    actor_id: str,
    pr_number: int,
    session: AsyncSession,
) -> dict:
    """Approves exactly one rule out of a (possibly multi-rule) merged PR —
    the per-rule body of what used to be the whole webhook handler before
    batch-propose support let one merge event carry several rules,
    extracted so it can run once per rule sharing a batched PR instead of
    exactly once per merge event.

    Never raises: every failure mode here (an unreadable/unparseable file,
    a lock conflict, a rejected approval signature) is caught and reported
    back as a status string instead, so one rule's failure can't take down
    the rest of the batch. This is a deliberate design call, not the
    default/easiest option — the alternative (fail the whole batch if any
    one rule's file is broken) would mean a single malformed rule in an
    8-rule PR blocks the other 7 from ever getting approved, potentially
    forever if that one rule's file problem isn't transient. Matches this
    codebase's existing bias toward graceful per-item degradation over
    all-or-nothing failure (see calibration.py/onboarding_metrics.py's own
    "instrumentation must never break the request it rides along with"
    discipline, and rule_conflict.py's best-effort conflict check) — the
    difference here is a rule staying un-approved (pending_merge) is a
    real, visible thing a human can go fix on GitHub, not a silently
    swallowed side effect."""
    rule_id = _bare_id(rule["slug"])

    # Read the merged file's real content rather than trusting whatever
    # propose_rule/batch_propose_rules originally rendered — a human may
    # have edited the PR's diff before merging, and the file was never
    # re-committed with the final approved status/PR info (it can't be —
    # it doesn't know its own PR number until the PR already exists). This
    # also means we deliberately do NOT call apps/store's git-sync here:
    # that path goes through the engine's own generic markdown importer,
    # which produces a differently-shaped page than this adapter's direct
    # writes (see store.ts's pageToRule) and — worse — would re-import
    # this exact file's still-"pending_merge" frontmatter, clobbering the
    # approval write below with stale content. Reading+parsing the file
    # ourselves and writing through the normal direct-write path avoids
    # both problems entirely.
    try:
        pat = await get_repo_token(connection)
        path = f"rules/{rule_id}.md"
        file_content = await get_file_content(connection.repo_url, pat, path, connection.default_branch)
        file_frontmatter, file_body = parse_rule_markdown(file_content)
    except (GithubClientError, GithubAppError) as exc:
        # GithubAppError only ever surfaces here for an App-connected org
        # (get_repo_token minting a fresh installation token) — same
        # never-raises, degrade-gracefully treatment as a GithubClientError
        # reading the file itself, so a transient App-auth hiccup on one
        # rule can't take down its siblings in the same batch either.
        return {"rule_id": rule_id, "status": "error", "error": f"could not read the merged file: {exc}"}
    except ValueError as exc:
        return {"rule_id": rule_id, "status": "error", "error": f"could not parse the merged file: {exc}"}

    before = dict(rule)
    now = datetime.now(timezone.utc).isoformat()
    # A merged PR's file content is a human-editable diff, not something
    # this service ever generated — sanitize on the way in, same as every
    # other path that ends up in front of a model (check_action's
    # _format_rules and rule_conflict's judge_conflict both read title/body
    # straight off the stored rule with no sanitization of their own, so
    # this write is the one place that has to catch it for every future
    # reader, not just today's).
    rule["title"] = sanitize(file_frontmatter.get("title") or rule["title"])
    rule["body"] = sanitize(file_body or rule["body"])
    for key in _EDITABLE_FROM_FILE:
        if key in file_frontmatter:
            rule[_snake_to_camel(key)] = file_frontmatter[key]
    rule["status"] = "approved"
    rule["approvedBy"] = actor_id
    rule["approvedAt"] = now
    rule["lastValidatedAt"] = now
    # prNumber/prUrl deliberately kept, not cleared — the merged PR is
    # exactly the record of what approved this rule, worth keeping as
    # provenance (see RulePageSchema's own note that this is left
    # unconstrained for approved rules).

    previous_slug = rule["previousVersionId"]
    previous: dict | None = None
    previous_before: dict | None = None
    # Falls back to the rule's own slug when there's no previous version to
    # supersede — GitHub can redeliver the same "closed, merged" event more
    # than once, and without a lock here two concurrent deliveries for the
    # very same PR could both read the still-pending_merge rule and both
    # attempt to approve it. Keyed per-rule (via this rule's own
    # previousVersionId/slug), not per-PR — two unrelated rules batched
    # onto the same PR never contend for the same lock, so one rule's lock
    # wait/conflict has no effect on its siblings' own lock acquisition.
    lock_key = f"approve_lock:{connection.org_id}:{previous_slug or rule['slug']}"
    # Same Redis lock approve_rule used to hold directly — reused here
    # verbatim, since the same race (two sibling edits' approvals landing
    # concurrently, or one PR's merge event delivered twice) is possible via
    # two near-simultaneous merges just as it was via two near-simultaneous
    # keypresses.
    lock_token = await acquire_lock(lock_key)
    if lock_token is None:
        return {"rule_id": rule_id, "status": "retry", "error": "another approval in progress, will retry"}

    try:
        if previous_slug is not None:
            previous = await store_get_rule(connection.org_id, previous_slug)
            if previous is not None and previous["supersededBy"] is not None:
                # Already superseded by a different approval — this merge
                # lost the race. Not an error; just don't touch anything.
                return {"rule_id": rule_id, "status": "already_superseded"}

        content_hash = hash_approval_content(
            title=rule["title"], body=rule["body"], tags=rule["tags"], status=rule["status"]
        )
        signature_value = sign_approval(
            org_id=connection.org_id,
            slug=rule["slug"],
            version=rule["version"],
            content_hash=content_hash,
        )
        try:
            await put_rule(rule, approval_signature=signature_value)
        except ApprovalRejected:
            return {"rule_id": rule_id, "status": "error", "error": "approval rejected"}

        if previous is not None:
            previous_before = dict(previous)
            previous["status"] = "deprecated"
            previous["supersededBy"] = rule["slug"]
            await put_rule(previous)
    finally:
        await release_lock(lock_key, lock_token)

    await append_audit(
        org_id=connection.org_id,
        rule_slug=rule["slug"],
        actor_id=actor_id,
        action="approved",
        before=before,
        after=rule,
    )
    if previous is not None:
        await append_audit(
            org_id=connection.org_id,
            rule_slug=previous["slug"],
            actor_id=actor_id,
            action="deprecated",
            before=previous_before,
            after=previous,
        )

    # Mirrors the pre-batch handler's own per-merge side effects, now once
    # per rule instead of once per event — log_onboarding_event and
    # enqueue_compile are both append-only/dedup-safe (enqueue_compile
    # dedupes on job id, see its own docstring), so firing them N times for
    # N approved rules in one batch has no downside beyond N (cheap) calls.
    await log_onboarding_event(session, connection.org_id, "rule_approved")
    # Calibration data — a no-op unless propose_rule/batch_propose_rules
    # flagged a conflict on this exact PR for this exact rule; see
    # calibration.py's docstring.
    await log_conflict_override_if_flagged(session, connection.org_id, rule["slug"], pr_number)
    # The knowledge-unit capture pipeline used to be what (accidentally)
    # kept skill packs fresh — every capture recompiled the org's pack, so
    # an approved rule showed up in the next one regardless. Now that
    # pipeline's gone, this is the only remaining trigger: without it, a
    # newly approved rule would never reach `gnt pull`/get_skill_pack until
    # something else in the org happened to recompile.
    await enqueue_compile(connection.org_id)
    return {"rule_id": rule_id, "status": "approved"}


def _snake_to_camel(key: str) -> str:
    """rule dicts are camelCase (the store's own convention); the file's
    frontmatter and _EDITABLE_FROM_FILE are snake_case (matching
    render.py/routers/rules.py's REST field names) — this is the one
    conversion point between the two."""
    head, *rest = key.split("_")
    return head + "".join(word.capitalize() for word in rest)

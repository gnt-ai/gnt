"""Nightly Intercom sync — a continuous SERVER-SIDE
connector, not a CLI-local one-shot. Same founder decision behind Zendesk's
connector (recorded 2026-07-18): an Intercom access token is a
standing server-side credential a scheduled job reads on its own
timetable, the same shape as Slack's bot token, GitHub's PAT, or
Zendesk's API token — not something a human runs a one-shot
`gnt prebrain` walker against from their own device the way the MCP-in
connectors under apps/cli/src/prebrain do.

Reads three kinds of prose from a customer's own Intercom workspace:
saved-reply (macro) text, help-center article bodies, and internal
(non-public) notes on recently-updated conversations. Never reads a
contact RECORD itself (email, phone, name, external_id, custom
attributes, location, companies, tags, segments, ...) — see
gnt.intercom.client's ConversationRef dataclass and its own docstring for
how that's enforced structurally, and tests/test_intercom_client.py's
declared-fields test for the proof.

Follows the same reference two-tier session pattern every cron job in
this codebase uses (workers/tasks_staleness.py, workers/tasks_zendesk.py):
enumerate org ids through get_cron_sessionmaker() (BYPASSRLS, the narrow
gnt_cron exemption), then do every actual per-org read/write through a
normal scope_to_org'd session, one org at a time, never a single
cross-org statement.

Pipeline per org, per content item — identical shape to Zendesk's sync:
  1. Skip if this exact (item, content) pair has already been through
     extraction before (gnt.intercom_sync_status.has_been_processed) —
     the dedup gate that keeps a large, mostly-unchanged Intercom
     workspace from re-extracting its whole saved-reply library and
     conversation history every night.
  2. Run the raw text through the server-side privacy gate
     (gnt.pipeline.privacy_gate) BEFORE anything else touches it,
     including the extraction LLM call — the founder decision behind this
     connector (same one behind Zendesk's) requires masking to happen
     before extraction, not merely before storage, since a saved reply or
     internal note is exactly the ambient third-party content that gate
     exists for. This module's content_extraction_model call NEVER sees
     unmasked Intercom content.
  3. Check the org's per-org LLM spend quota (the cost gate that runs
     before any paid model call) before spending an extraction call; stop
     the org's run once exhausted, same quiet-break shape
     workers/tasks_zendesk.py's own per-item budget check uses, never a
     raised exception mid-sync.
  4. Extract zero or more candidate rules from the masked text
     (gnt.pipeline.content_extraction — the SAME generic extraction
     function Zendesk's sync uses, not a second implementation).
  5. For each candidate: create a draft rule (routers/rules.py's
     create_draft_rule, apply_privacy_gate=False — the content reaching it
     was already gate-masked upstream in step 2), submit it for review,
     and — only if the org has a connected GitHub repo — propose it (open
     a PR), the exact same draft -> submit -> propose lifecycle
     workers/tasks_zendesk.py already gives its own sweep-generated
     drafts. An org with Intercom connected but no GitHub repo yet still
     gets its candidate drafts created and submitted — visible in the
     normal review queue — it just has nowhere to open a PR against until
     GitHub is connected too.
  6. Record the item as processed regardless of whether extraction
     produced any candidates, so a saved reply with genuinely no policy
     content in it isn't re-sent to the model every single night.

Bounded per org per run by Settings.intercom_sweep_max_items_per_org —
saved replies, changed conversations' internal notes, and help-center
articles combined — same founder-tunable-knob convention
zendesk_sweep_max_items_per_org already establishes.

Errors skip-and-report, never crash the worker: one bad item (a
malformed Intercom payload, an unreachable conversation, an LLM failure)
skips that one item and keeps going (_process_item's own try/except); a
credential going bad mid-run (Intercom revokes a token, an outage) fails
that one org's sync and is recorded via intercom_sync_states' last_error,
never raised past sync_intercom_for_org; one org's failure never stops
the rest of the night's orgs (sync_intercom's own per-org loop)."""

import hashlib
from datetime import datetime, timedelta, timezone
from typing import Any

import sentry_sdk
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.config import get_settings
from gnt.db.models import GithubConnection, IntercomConnection, Org
from gnt.db.rls import scope_to_org
from gnt.db.session import get_cron_sessionmaker, get_sessionmaker
from gnt.github.app_auth import get_repo_token
from gnt.github.client import GithubClientError
from gnt.intercom.client import (
    IntercomClientError,
    list_articles,
    list_internal_notes,
    list_recently_updated_conversation_ids,
    list_saved_replies,
)
from gnt.intercom.crypto import decrypt_token as decrypt_intercom_token
from gnt.intercom_sync_status import has_been_processed, record_processed, record_sync_result
from gnt.llm_quota import check_llm_quota, record_llm_usage
from gnt.pipeline.content_extraction import extract_candidate_rules_async
from gnt.pipeline.privacy_gate import apply_privacy_gate
from gnt.pipeline.privacy_gate.redaction_record import build_redaction_record
from gnt.routers.rules import CreateRuleRequest, create_draft_rule, propose_rule_for_org, submit_rule_for_review
from gnt.store_client import append_audit

# Same cross-worker "no real human behind this write" actor id convention
# as tasks_zendesk.py's _SYNC_ACTOR_ID / tasks_contradictions.py's
# _SWEEP_ACTOR_ID.
_SYNC_ACTOR_ID = "gnt:intercom-sync"

# How far back the conversation search looks for "recently updated"
# conversations whose internal notes are worth checking — a fixed rolling
# window, not "since the last successful run", same reasoning as Zendesk's
# _TICKET_LOOKBACK_DAYS: a sync that's been broken for a while and then
# recovers doesn't try to walk an unbounded backlog once it does.
_CONVERSATION_LOOKBACK_DAYS = 7

_PR_INTRO = (
    "Opened automatically by gnt's nightly Intercom sync — "
    "extracted from support content (a saved reply, an internal conversation note, "
    "or a help-center article), a human needs to review this before it's real "
    "policy. Reject or edit this PR if the extraction got it wrong."
)


def _fingerprint(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


async def sync_intercom(ctx: dict[str, Any]) -> None:
    """arq cron entrypoint (see worker.py's cron_jobs). Enumerates every
    org, then runs that org's own Intercom sync — see module docstring
    for why enumeration and the per-org work use two different
    sessions/roles."""
    cron_session_factory = get_cron_sessionmaker()
    async with cron_session_factory() as session:
        org_ids = [row[0] for row in (await session.execute(select(Org.id))).all()]

    for org_id in org_ids:
        await sync_intercom_for_org(org_id)


async def sync_intercom_for_org(org_id: str) -> None:
    """The per-org unit of work sync_intercom loops over. An org with no
    connected Intercom workspace is skipped outright, same "not an error"
    treatment every other sweep gives an org that hasn't connected the
    thing it depends on. Otherwise, always writes exactly one
    intercom_sync_states row for this run, success or failure — see this
    module's own docstring and gnt.intercom_sync_status.record_sync_result."""
    session_factory = get_sessionmaker()
    async with session_factory() as session:
        await scope_to_org(session, org_id)
        connection = (
            await session.execute(select(IntercomConnection).where(IntercomConnection.org_id == org_id))
        ).scalar_one_or_none()
        if connection is None:
            return

        try:
            items_scanned, candidates_proposed = await _run_sync(session, org_id, connection)
            await record_sync_result(
                session, org_id, ok=True, error=None,
                items_scanned=items_scanned, candidates_proposed=candidates_proposed,
            )
        except Exception as exc:
            sentry_sdk.capture_exception(exc)
            # Org-level failure (bad/revoked credentials, Intercom outage) —
            # counts reset to 0 rather than reporting a partial in-flight
            # count as if it were this run's real total; last_error is what
            # a customer needs to see, not an approximate scan count.
            await record_sync_result(
                session, org_id, ok=False, error=str(exc)[:500], items_scanned=0, candidates_proposed=0
            )


async def _iter_content_items(access_token: str, budget: int):
    """Lazily yields (item_type, item_id, text, source_label, source)
    tuples across saved replies, help-center articles, and recently-
    updated conversations' internal notes, in that order, stopping as
    soon as `budget` items total have been yielded — so a budget-
    exhausted run never even makes the Intercom API calls for whichever
    source comes later in the order. item_type is one of
    "saved_reply" | "article" | "internal_note", matching
    intercom_processed_items.item_type."""
    yielded = 0

    for reply in await list_saved_replies(access_token):
        if yielded >= budget:
            return
        yield (
            "saved_reply", reply.id, reply.action_text,
            f"Intercom saved reply: {reply.title}", f'Intercom saved reply "{reply.title}"',
        )
        yielded += 1

    if yielded >= budget:
        return
    for article in await list_articles(access_token, limit=budget - yielded):
        if yielded >= budget:
            return
        yield (
            "article", article.id, article.body_text,
            f"Intercom help center article: {article.title}",
            article.html_url or f'Intercom article "{article.title}"',
        )
        yielded += 1

    if yielded >= budget:
        return
    start_time_unix = int(
        (datetime.now(timezone.utc) - timedelta(days=_CONVERSATION_LOOKBACK_DAYS)).timestamp()
    )
    conversation_refs = await list_recently_updated_conversation_ids(
        access_token, start_time_unix=start_time_unix, limit=budget - yielded
    )
    for conversation in conversation_refs:
        if yielded >= budget:
            return
        try:
            notes = await list_internal_notes(access_token, conversation_id=conversation.id)
        except IntercomClientError as exc:
            # One conversation's notes failing to fetch (deleted mid-sync,
            # transient error) skips just that conversation — never the
            # rest of the org's sync.
            sentry_sdk.capture_exception(exc)
            continue
        for note in notes:
            if yielded >= budget:
                return
            yield (
                "internal_note", f"{conversation.id}:{note.note_id}", note.body_text,
                f"Intercom internal note on conversation #{conversation.id}",
                f"Intercom conversation #{conversation.id} (internal note)",
            )
            yielded += 1


async def _run_sync(session: AsyncSession, org_id: str, connection: IntercomConnection) -> tuple[int, int]:
    settings = get_settings()
    access_token = decrypt_intercom_token(connection.access_token_encrypted)

    github_connection = (
        await session.execute(select(GithubConnection).where(GithubConnection.org_id == org_id))
    ).scalar_one_or_none()
    # A mint failure here (App-connected org, revoked/broken installation)
    # propagates up to sync_intercom_for_org's own broad except -- same
    # org-level failure treatment as a bad Intercom credential or an
    # Intercom outage, not something this function needs to catch itself.
    github_pat = await get_repo_token(github_connection) if github_connection else None

    items_scanned = 0
    candidates_proposed = 0
    async for item_type, item_id, text, source_label, source in _iter_content_items(
        access_token, settings.intercom_sweep_max_items_per_org
    ):
        # Per-org LLM spend quota check, checked before every extraction
        # call this loop is about to make, same quiet-break shape
        # tasks_zendesk.py's own per-item budget check uses.
        if not await check_llm_quota(org_id):
            break
        candidates_proposed += await _process_item(
            session, org_id, github_connection, github_pat,
            item_type=item_type, item_id=item_id, text=text, source_label=source_label, source=source,
        )
        items_scanned += 1

    return items_scanned, candidates_proposed


async def _process_item(
    session: AsyncSession,
    org_id: str,
    github_connection: GithubConnection | None,
    github_pat: str | None,
    *,
    item_type: str,
    item_id: str,
    text: str,
    source_label: str,
    source: str,
) -> int:
    """One content item, start to finish: dedup check, privacy gate,
    extraction, then a draft (and, when possible, a proposed PR) per
    candidate. Returns how many candidate rules this item produced.

    Wrapped in one broad except — same "one bad item never derails the
    rest of the org's run" discipline every other sweep in this codebase
    applies to its own per-item loop: a malformed Intercom payload, an LLM
    error, or a store hiccup here skips this one item, never the rest of
    the sync."""
    try:
        fingerprint = _fingerprint(item_type, item_id, text)
        if await has_been_processed(session, org_id, item_type, item_id, fingerprint):
            return 0

        # Masked BEFORE extraction, not just before storage. See module
        # docstring.
        gate_result = apply_privacy_gate(text)

        candidates, input_tokens, output_tokens = await extract_candidate_rules_async(
            source_label, gate_result.masked_text
        )
        await record_llm_usage(org_id, get_settings().content_extraction_model, input_tokens, output_tokens)

        proposed = 0
        for candidate in candidates:
            proposed += await _create_and_propose_candidate(
                session, org_id, github_connection, github_pat, candidate, source, gate_result.hits
            )

        await record_processed(session, org_id, item_type, item_id, fingerprint)
        return proposed
    except Exception as exc:
        sentry_sdk.capture_exception(exc)
        return 0


async def _create_and_propose_candidate(
    session: AsyncSession,
    org_id: str,
    github_connection: GithubConnection | None,
    github_pat: str | None,
    candidate: Any,
    source: str,
    privacy_gate_hits: list,
) -> int:
    """Pushes one extracted candidate through create -> submit -> (propose
    if possible), returning 1 always — a failure at the propose step is
    best-effort (see below) and must not undo the draft that already
    exists, so this never returns 0 once the draft itself was created."""
    rule = await create_draft_rule(
        org_id,
        _SYNC_ACTOR_ID,
        CreateRuleRequest(title=candidate.title, body=candidate.body, source=source, tags=["intercom"]),
        # Already gate-masked upstream (see _process_item) — apply_privacy_gate
        # here would re-run the gate over content built purely from
        # already-masked input, which create_draft_rule's own docstring
        # reserves for content a human/agent hasn't already had gated.
        apply_privacy_gate=False,
    )
    if privacy_gate_hits:
        # Same "privacy_gate_masked" audit entry create_draft_rule writes
        # itself when apply_privacy_gate=True — replicated by hand here
        # since this path gates before extraction rather than inside that
        # call, but the audit-trail shape a customer sees is identical.
        await append_audit(
            org_id=org_id,
            rule_slug=rule["slug"],
            actor_id=_SYNC_ACTOR_ID,
            action="privacy_gate_masked",
            before=None,
            after=build_redaction_record(privacy_gate_hits),
        )

    rule = await submit_rule_for_review(org_id, _SYNC_ACTOR_ID, rule)

    if github_connection is not None:
        try:
            await propose_rule_for_org(
                org_id, _SYNC_ACTOR_ID, rule, github_connection, github_pat, session, pr_intro=_PR_INTRO
            )
        except GithubClientError as exc:
            # Best-effort — same discipline tasks_zendesk.py's
            # _create_and_propose_candidate documents: the draft already
            # exists and is already submitted (visible in the normal
            # review queue) regardless of whether opening a PR for it
            # succeeds.
            sentry_sdk.capture_exception(exc)

    return 1

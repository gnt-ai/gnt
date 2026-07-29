"""Read/write helpers for the two Zendesk-sync-owned tables
(workers/tasks_zendesk.py):

zendesk_processed_items — dedup log gating which macro/internal-note/
article content gets sent to the content_extraction_model at all. Same
role and same discipline as gnt.contradiction_findings /
gnt.staleness_refresh for their own sweeps: has_been_processed is a plain
read used to gate a paid LLM call before it happens (re-scopes but doesn't
swallow a failure — a bug here should surface and skip that one item via
the caller's own try/except, not silently return False and risk
re-extracting content that's already produced a draft rule); record_processed
owns its own scope/commit and swallows its own failures, since it must
never break the sync run it rides along with.

zendesk_sync_states — the sync-status health surface (last successful
sync, last error) GET /v1/settings/zendesk/sync-status reads. A full-
snapshot upsert per org, not an append-only log — see that model's own
docstring in db/models.py. record_sync_result is the ONE place that ever
writes this table, called exactly once per org per run regardless of
whether the run succeeded, so "last synced" always reflects the most
recent attempt even when that attempt failed outright.
"""

from datetime import datetime, timezone

import sentry_sdk
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.db.models import ZendeskProcessedItem, ZendeskSyncState
from gnt.db.rls import scope_to_org


async def has_been_processed(
    session: AsyncSession, org_id: str, item_type: str, item_id: str, content_fingerprint: str
) -> bool:
    await scope_to_org(session, org_id)
    existing = (
        await session.execute(
            select(ZendeskProcessedItem.id).where(
                ZendeskProcessedItem.org_id == org_id,
                ZendeskProcessedItem.item_type == item_type,
                ZendeskProcessedItem.item_id == item_id,
                ZendeskProcessedItem.content_fingerprint == content_fingerprint,
            )
        )
    ).scalar_one_or_none()
    return existing is not None


async def record_processed(
    session: AsyncSession, org_id: str, item_type: str, item_id: str, content_fingerprint: str
) -> None:
    """Called once an item has actually been run through extraction
    (regardless of whether extraction produced any candidates) — a row
    with no real extraction attempt behind it would silently suppress a
    future retry of content that was never actually looked at."""
    try:
        await scope_to_org(session, org_id)
        session.add(
            ZendeskProcessedItem(
                org_id=org_id, item_type=item_type, item_id=item_id, content_fingerprint=content_fingerprint
            )
        )
        await session.commit()
    except Exception as exc:
        sentry_sdk.capture_exception(exc)
        await session.rollback()


async def get_sync_status(session: AsyncSession, org_id: str) -> dict:
    """Read side of the sync-status health surface — GET
    /v1/settings/zendesk/sync-status's one data source. Returns a plain
    "never synced" shape (all fields null/zero) rather than 404ing when no
    row exists yet, since a connection that's never had a nightly run
    fire is a normal, expected state (connect happened after tonight's
    cron already ran), not an error."""
    await scope_to_org(session, org_id)
    row = (
        await session.execute(select(ZendeskSyncState).where(ZendeskSyncState.org_id == org_id))
    ).scalar_one_or_none()
    if row is None:
        return {
            "last_synced_at": None,
            "last_success_at": None,
            "last_error": None,
            "last_error_at": None,
            "items_scanned_last_run": 0,
            "candidates_proposed_last_run": 0,
        }
    return {
        "last_synced_at": row.last_synced_at,
        "last_success_at": row.last_success_at,
        "last_error": row.last_error,
        "last_error_at": row.last_error_at,
        "items_scanned_last_run": row.items_scanned_last_run,
        "candidates_proposed_last_run": row.candidates_proposed_last_run,
    }


async def record_sync_result(
    session: AsyncSession,
    org_id: str,
    *,
    ok: bool,
    error: str | None,
    items_scanned: int,
    candidates_proposed: int,
) -> None:
    """The one write to zendesk_sync_states, called exactly once per org
    per run from workers/tasks_zendesk.py's own top-level try/except — see
    that module for why the write happens there rather than deeper in the
    call chain. On success, last_error/last_error_at are explicitly reset
    to null so a customer who fixed a previously-broken connection doesn't
    keep seeing a stale error from a run that's since recovered."""
    now = datetime.now(timezone.utc)
    values = {
        "org_id": org_id,
        "last_synced_at": now,
        "last_success_at": now if ok else None,
        "last_error": None if ok else error,
        "last_error_at": None if ok else now,
        "items_scanned_last_run": items_scanned,
        "candidates_proposed_last_run": candidates_proposed,
    }
    await scope_to_org(session, org_id)
    stmt = insert(ZendeskSyncState).values(**values)
    set_ = dict(values)
    del set_["org_id"]
    if ok:
        # A failed run must not clobber the previous run's last_success_at
        # with null — only a successful run ever advances that column.
        set_["last_success_at"] = stmt.excluded.last_success_at
    else:
        del set_["last_success_at"]
    stmt = stmt.on_conflict_do_update(index_elements=["org_id"], set_=set_)
    await session.execute(stmt)
    await session.commit()

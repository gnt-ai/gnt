"""org_contacts.get_digest_recipients (who to email for an org). This
codebase's test database is migrated only through
Alembic (`alembic upgrade head` — see conftest.py's _migrated_test_db
fixture); Better Auth's own "member"/"user" tables are created by a
separate Node-side migration tool (`pnpm exec auth migrate`) this test
suite never runs, so they genuinely do NOT exist here — the same
uninstalled-in-this-environment situation a real deploy could still hit if
gnt_app turns out to lack grants on tables Better Auth's migration
created under a different role (see this module's own docstring).

That makes this the most honest test available: it proves the real
"table/columns don't exist or aren't queryable" failure mode degrades to
an empty recipient list and a captured exception, never a raised error —
exactly the contract workers/tasks_digest.py depends on to skip one org's
digest without crashing the whole cron run."""

from gnt.db.org import ensure_org
from gnt.org_contacts import get_digest_recipients


async def test_get_digest_recipients_degrades_to_empty_list_when_the_query_fails(
    db_session, org_a, monkeypatch
):
    captured: list[Exception] = []
    monkeypatch.setattr("gnt.org_contacts.sentry_sdk.capture_exception", lambda exc: captured.append(exc))

    await ensure_org(db_session, org_a)
    await db_session.commit()

    recipients = await get_digest_recipients(db_session, org_a)

    assert recipients == []
    # Better Auth's member/user tables aren't part of this test DB's schema
    # (see module docstring) -- this run's failure is specifically that
    # "relation does not exist" case, proving the degrade-not-crash path
    # actually triggers rather than the query somehow silently matching
    # zero rows on its own.
    assert len(captured) == 1

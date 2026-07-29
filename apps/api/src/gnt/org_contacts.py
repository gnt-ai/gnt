"""Who to email for an org — the weekly digest (gnt.email,
workers/tasks_digest.py) needs a real contact address, and nothing in this codebase's own Alembic-managed
tables has one: Org (db/models.py) is Better Auth org identity mirrored
lazily (db/org.py's ensure_org), with no email column of its own.

Better Auth (apps/web/lib/auth.ts) owns the actual answer, in its own
tables in this SAME physical Postgres database (see that file's own
comment: "Same physical Postgres database apps/api's Alembic migrations
manage — Better Auth owns its own tables (user, session, account,
organization, member, invitation, jwks, ...) via its own migration tool").
This module reads those tables directly with raw SQL — there's no
SQLAlchemy model for them here (they're not Alembic's to own), and no
prior art in this codebase for reading them from apps/api at all.

Better Auth's default schema (confirmed against better-auth@1.6.23's own
core/organization plugin schema, not guessed): table "member" has columns
id/organizationId/userId/role/createdAt; table "user" has
id/email/emailVerified/name/image/createdAt/updatedAt. apps/web/lib/auth.ts
doesn't set `usePlural` or any `modelName`/`fields` overrides, so the
column names above are the real ones, camelCase, exactly as Better Auth's
schema defines them (Kysely's default adapter behavior when no custom
field-name mapping is configured) — not renamed to snake_case anywhere in
this stack.

This is genuinely new, unverified-against-a-live-database ground (this
codebase's tests never seed Better Auth's own tables — they're created by
`pnpm exec auth migrate`, a separate Node-side migration path the Python
test suite doesn't run), so every call here is wrapped and degrades to an
empty recipient list on any failure: a wrong assumption about grants,
schema, or column names must skip that org's digest email for that run,
never crash the cron job or any other org's run. See
workers/tasks_digest.py for the caller and its own skip-and-log behavior
when this returns nothing.

Verified against the real production database (2026-07-17): schema and
gnt_app's grants were both fine, but the query itself had a real bug —
`ANY(:roles::text[])` (bind parameter immediately followed by a `::`
cast) isn't reliably converted from named to positional parameters by
SQLAlchemy's asyncpg dialect, so the raw `:roles::text[]` text reached
Postgres unparsed and failed with a syntax error on every call, silently
swallowed by the try/except below — every digest would have found zero
recipients, forever. `CAST(:roles AS text[])` avoids the ambiguous
colon-adjacency entirely and was confirmed working against a real org's
real owner row.
"""

import sentry_sdk
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

# owner/admin only — mirrors auth/better_auth.py's _ADMIN_ROLES exactly
# (the org creator defaults to "owner"), since a digest is exactly the
# kind of "acting for the org" signal that role gate already models. A
# plain "member" gets no digest — same reasoning Better Auth's own
# organization plugin uses admin roles for org-level settings/billing.
_ADMIN_ROLES = ("owner", "admin")

_RECIPIENTS_QUERY = text(
    """
    SELECT DISTINCT "user"."email"
    FROM "member"
    JOIN "user" ON "user"."id" = "member"."userId"
    WHERE "member"."organizationId" = :org_id
      AND "member"."role" = ANY(CAST(:roles AS text[]))
      AND "user"."emailVerified" = true
    """
)


async def get_digest_recipients(session: AsyncSession, org_id: str) -> list[str]:
    """This org's owner/admin verified email addresses, straight out of
    Better Auth's own member/user tables — deliberately NOT scoped through
    scope_to_org/app.current_org: those tables carry no RLS policy (they're
    outside migration 0007's Alembic-managed set entirely), so the
    organizationId filter in the query itself is the only scoping that
    exists, same as every other explicit-WHERE query in this codebase —
    RLS is defense in depth on top of that, not a replacement for it.

    Returns [] (never raises) if the query fails for any reason — wrong
    table/column-name assumption, gnt_app lacking SELECT grants on tables
    Better Auth's own migration tool created under a different role, a
    genuine DB hiccup. See this module's own docstring for why that's the
    deliberate contract here, not a bug to be tightened later without
    also verifying the query against a real deployed database first."""
    try:
        rows = (await session.execute(_RECIPIENTS_QUERY, {"org_id": org_id, "roles": list(_ADMIN_ROLES)})).all()
        return [row[0] for row in rows if row[0]]
    except Exception as exc:
        sentry_sdk.capture_exception(exc)
        await session.rollback()
        return []

from sqlalchemy import func, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.config import get_settings
from gnt.db.models import Org
from gnt.db.rls import scope_to_org


async def ensure_org(session: AsyncSession, org_id: str) -> None:
    """Better Auth owns org identity; this lazily mirrors an org_id into
    our orgs table the first time it's seen, since it's the FK target for
    everything else.

    Sets app.current_org to org_id first — a real chicken-and-egg case
    RLS's WITH CHECK otherwise can't satisfy: inserting the very row that
    proves the org exists needs the GUC to already equal the org_id being
    inserted. This was invisible everywhere ensure_org is called until the
    app stopped connecting as a superuser (migration 0013), since a
    superuser bypasses RLS entirely regardless of the GUC. Also means
    callers that call ensure_org first, then do more org-scoped writes in
    the same transaction, get scoped "for free" without a separate
    scope_to_org call — most of them were already relying on that
    ordering without it actually having taken effect."""
    await scope_to_org(session, org_id)
    # billing_trial_days is a trusted server config int, never user input --
    # interval literals don't support bind parameters, so this interpolates
    # the (int-coerced) value directly rather than taking a raw string.
    trial_days = int(get_settings().billing_trial_days)
    trial_ends_at = func.now() + text(f"interval '{trial_days} days'")
    stmt = (
        insert(Org)
        .values(id=org_id, trial_ends_at=trial_ends_at)
        .on_conflict_do_nothing(index_elements=["id"])
    )
    await session.execute(stmt)

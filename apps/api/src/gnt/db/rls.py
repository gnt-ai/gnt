from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def scope_to_org(session: AsyncSession, org_id: str) -> None:
    """Sets the app.current_org GUC for this transaction.

    Defense-in-depth: application code already filters every query by
    org_id explicitly, this just gives the database a second, independent
    way to enforce it once RLS policies are enabled on tables (M6).
    """
    # SET LOCAL doesn't accept bind parameters (Postgres parses SET's value
    # as a literal/identifier, not a protocol-level param) — set_config()
    # is a real function call, so it takes a normal parameterized argument.
    # true = local (transaction-scoped), same lifetime SET LOCAL would give.
    await session.execute(
        text("SELECT set_config('app.current_org', :org_id, true)"), {"org_id": org_id}
    )

from typing import Any

from gnt.compiler.pack import compile_skill_pack
from gnt.db.rls import scope_to_org
from gnt.db.session import get_sessionmaker


async def compile_skills(ctx: dict[str, Any], org_id: str) -> None:
    session_factory = get_sessionmaker()
    async with session_factory() as session:
        await scope_to_org(session, org_id)
        await compile_skill_pack(session, org_id)

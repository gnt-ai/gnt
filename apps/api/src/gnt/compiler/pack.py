import hashlib

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt import store_client
from gnt.compiler.cluster import cluster_rules_by_tag
from gnt.compiler.render_rules import render_index, render_tag_rules_skill
from gnt.db.models import SkillFile, SkillPack


async def compile_skill_pack(session: AsyncSession, org_id: str) -> SkillPack:
    """Compiles this org's approved, git-native rules into a versioned
    SKILL.md bundle (`gnt pull`, get_skill_pack/list_skill_packs). Used to
    also fold in the old knowledge_units pipeline's topic files — that half
    was removed along with the pipeline itself (ask_brain/search_knowledge),
    see the PR that added this comment for why."""
    # Let a store outage fail this compile loudly (ARQ retries the job)
    # rather than silently shipping a pack with rules quietly missing.
    rules = await store_client.list_rules(org_id, status="approved")

    version_result = await session.execute(
        select(func.max(SkillPack.version)).where(SkillPack.org_id == org_id)
    )
    version = (version_result.scalar() or 0) + 1

    rule_tags = cluster_rules_by_tag(rules)
    manifest = {
        "rule_count": len(rules),
        "rule_tags": list(rule_tags.keys()),
    }

    pack = SkillPack(org_id=org_id, version=version, manifest=manifest)
    session.add(pack)
    await session.flush()

    files = [
        SkillFile(
            pack_id=pack.id,
            path="SKILL.md",
            content=(index_content := render_index(list(rule_tags.keys()), version)),
            sha256=hashlib.sha256(index_content.encode()).hexdigest(),
        )
    ]
    for tag, tag_rules in rule_tags.items():
        content = render_tag_rules_skill(tag, version, tag_rules)
        files.append(
            SkillFile(
                pack_id=pack.id,
                path=f"skills/rules/{tag}/SKILL.md",
                content=content,
                sha256=hashlib.sha256(content.encode()).hexdigest(),
            )
        )

    session.add_all(files)
    await session.commit()
    return pack

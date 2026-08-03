import hashlib
import io
import uuid
import zipfile

from gnt.db.models import SkillFile, SkillPack
from gnt.db.org import ensure_org
from gnt.db.rls import scope_to_org
from gnt.routers import skill_packs as skill_packs_router
from tests.conftest import make_org_client


async def _insert_pack(db_session, org_id: str, version: int, files: dict[str, str]) -> None:
    await ensure_org(db_session, org_id)
    pack = SkillPack(org_id=org_id, version=version, manifest={})
    db_session.add(pack)
    await db_session.flush()
    for path, content in files.items():
        db_session.add(
            SkillFile(
                pack_id=pack.id,
                path=path,
                content=content,
                sha256=hashlib.sha256(content.encode()).hexdigest(),
            )
        )
    await db_session.flush()


def _org_id() -> str:
    return f"org_test_download_{uuid.uuid4().hex[:8]}"


async def test_latest_skill_pack_returns_404_when_org_has_no_pack(
    db_session, test_app_factory
):
    org_id = _org_id()
    await scope_to_org(db_session, org_id)
    async with make_org_client(
        test_app_factory, org_id, routers=[skill_packs_router.router]
    ) as client:
        response = await client.get("/v1/skill-packs/latest.zip")

    assert response.status_code == 404
    assert response.json()["detail"] == "no skill pack yet"


async def test_latest_skill_pack_serves_highest_version_as_zip(db_session, test_app_factory):
    org_id = _org_id()
    await _insert_pack(db_session, org_id, 1, {"old.txt": "old"})
    await _insert_pack(
        db_session,
        org_id,
        2,
        {"SKILL.md": "latest skill", "rules/refund.md": "refund rule"},
    )
    await scope_to_org(db_session, org_id)

    async with make_org_client(
        test_app_factory, org_id, routers=[skill_packs_router.router]
    ) as client:
        response = await client.get("/v1/skill-packs/latest.zip")

    assert response.status_code == 200
    assert response.headers["content-disposition"] == (
        "attachment; filename=gnt-pack-v2.zip"
    )
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.namelist() == ["SKILL.md", "rules/refund.md"]
        assert archive.read("SKILL.md") == b"latest skill"
        assert archive.read("rules/refund.md") == b"refund rule"


async def test_latest_skill_pack_does_not_leak_files_between_orgs(db_session, test_app_factory):
    org_a = _org_id()
    org_b = _org_id()
    await _insert_pack(db_session, org_a, 1, {"a.txt": "org A"})
    await _insert_pack(db_session, org_b, 1, {"b.txt": "org B"})
    await scope_to_org(db_session, org_a)

    async with make_org_client(
        test_app_factory, org_a, routers=[skill_packs_router.router]
    ) as client:
        response = await client.get("/v1/skill-packs/latest.zip")

    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.namelist() == ["a.txt"]
        assert archive.read("a.txt") == b"org A"
        assert "b.txt" not in archive.namelist()

import io
import zipfile

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.auth.better_auth import OrgContext
from gnt.billing import require_entitled_org
from gnt.db.models import SkillFile, SkillPack
from gnt.db.session import get_session

router = APIRouter(prefix="/v1", tags=["skill-packs"])


@router.get("/skill-packs/latest.zip")
async def latest_skill_pack(
    org: OrgContext = Depends(require_entitled_org),
    session: AsyncSession = Depends(get_session),
):
    pack = (
        await session.execute(
            select(SkillPack)
            .where(SkillPack.org_id == org.org_id)
            .order_by(SkillPack.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if pack is None:
        raise HTTPException(status_code=404, detail="no skill pack yet")

    files = (await session.execute(select(SkillFile).where(SkillFile.pack_id == pack.id))).scalars()

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for file in files:
            zf.writestr(file.path, file.content)
    buffer.seek(0)

    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=gnt-pack-v{pack.version}.zip"},
    )

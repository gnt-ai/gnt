import asyncio

import groq
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from gnt.auth.better_auth import OrgContext
from gnt.config import get_settings
from gnt.groq_client import get_client
from gnt.rate_limit import enforce_transcribe_rate_limit

router = APIRouter(prefix="/v1", tags=["transcribe"])


def _transcribe(filename: str, contents: bytes) -> str:
    result = get_client().audio.transcriptions.create(
        file=(filename, contents),
        model=get_settings().transcribe_model,
        response_format="text",
    )
    # response_format="text" returns the transcript as a bare string; other
    # formats (e.g. "json") return an object with a `.text` attribute.
    return result if isinstance(result, str) else result.text


@router.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    org: OrgContext = Depends(enforce_transcribe_rate_limit),
):
    contents = await file.read()
    max_size = get_settings().transcribe_max_file_size_bytes
    if len(contents) > max_size:
        raise HTTPException(
            status_code=400, detail=f"file too large — max {max_size // (1024 * 1024)}MB"
        )
    if not contents:
        raise HTTPException(status_code=400, detail="empty audio file")

    try:
        text = await asyncio.to_thread(_transcribe, file.filename or "audio.webm", contents)
    except groq.APIError:
        # Never surface upstream error bodies (could include account/billing
        # details) to the client.
        raise HTTPException(
            status_code=502, detail="transcription is temporarily unavailable — try again"
        ) from None

    return {"text": text.strip()}

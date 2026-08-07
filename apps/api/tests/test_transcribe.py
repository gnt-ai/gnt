"""POST /v1/transcribe — the one route that bills a real Groq call per
success, and the one place an upstream vendor error body could leak
straight through to a customer if the bare `except groq.APIError` ever
gets loosened. Covers size/empty gates, the no-leak 502 path, and both
`_transcribe` return shapes (bare string vs `.text` attribute).
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import groq
import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from gnt.auth.better_auth import OrgContext
from gnt.config import get_settings
from gnt.rate_limit import enforce_transcribe_rate_limit
from gnt.routers import transcribe as transcribe_router


@pytest.fixture
def transcribe_routers():
    return [transcribe_router.router]


@pytest.fixture
def client(test_app_factory, org_a, transcribe_routers):
    """Authenticated as org_a, with the rate-limit dependency short-circuited
    so these tests stay about the route's own gates/error handling — not
    Redis."""
    from gnt.auth.better_auth import get_current_org, require_admin, require_admin_session, require_session

    app = test_app_factory(transcribe_routers)
    org = OrgContext(org_id=org_a, user_id="user_transcribe", role=None, auth_kind="session")

    async def _org() -> OrgContext:
        return org

    app.dependency_overrides[get_current_org] = _org
    app.dependency_overrides[require_admin] = _org
    app.dependency_overrides[require_session] = _org
    app.dependency_overrides[require_admin_session] = _org
    app.dependency_overrides[enforce_transcribe_rate_limit] = _org
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _post_audio(client: AsyncClient, contents: bytes, filename: str = "clip.webm") -> httpx.Response:
    files = {"file": (filename, contents, "audio/webm")}
    async with client as c:
        return await c.post("/v1/transcribe", files=files)


async def test_file_over_max_size_returns_400_with_limit_in_mb(client):
    max_size = get_settings().transcribe_max_file_size_bytes
    too_big = b"x" * (max_size + 1)
    r = await _post_audio(client, too_big)
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert f"{max_size // (1024 * 1024)}MB" in detail


async def test_empty_file_returns_400(client):
    r = await _post_audio(client, b"")
    assert r.status_code == 400
    assert r.json()["detail"] == "empty audio file"


async def test_groq_api_error_returns_502_without_leaking_upstream_body(client, monkeypatch):
    leak = "SECRET_GROQ_BILLING_DETAIL_do_not_forward"

    def _boom(*_args, **_kwargs):
        raise groq.APIError(leak, None, body={"message": leak})

    fake = MagicMock()
    fake.audio.transcriptions.create.side_effect = _boom
    monkeypatch.setattr("gnt.routers.transcribe.get_client", lambda: fake)

    r = await _post_audio(client, b"not-empty-audio-bytes")
    assert r.status_code == 502
    body = r.text
    assert leak not in body
    assert r.json()["detail"] == "transcription is temporarily unavailable — try again"


async def test_success_with_bare_string_transcript(client, monkeypatch):
    fake = MagicMock()
    fake.audio.transcriptions.create.return_value = "  hello from groq  "
    monkeypatch.setattr("gnt.routers.transcribe.get_client", lambda: fake)

    r = await _post_audio(client, b"not-empty-audio-bytes")
    assert r.status_code == 200
    assert r.json() == {"text": "hello from groq"}


async def test_success_with_object_text_attribute(client, monkeypatch):
    fake = MagicMock()
    fake.audio.transcriptions.create.return_value = SimpleNamespace(text="  object shape  ")
    monkeypatch.setattr("gnt.routers.transcribe.get_client", lambda: fake)

    r = await _post_audio(client, b"not-empty-audio-bytes")
    assert r.status_code == 200
    assert r.json() == {"text": "object shape"}

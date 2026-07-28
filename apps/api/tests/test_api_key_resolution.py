"""resolve_api_key_row's last_used_at write throttling. Everything else
about key resolution (hashing, revocation) is covered by
test_mcp_auth_middleware.py and test_settings_keys.py — this file is
scoped to the write-frequency behavior only."""

import asyncio
import uuid
from datetime import timedelta

import pytest

import gnt.auth.api_key as api_key_module
from gnt.auth.api_key import resolve_api_key_row
from gnt.auth.mcp_keys import generate_key
from gnt.db.models import McpApiKey
from gnt.db.org import ensure_org


@pytest.fixture
async def org_and_key(db_session):
    org_id = f"__api_key_throttle_test_{uuid.uuid4().hex[:8]}__"
    await ensure_org(db_session, org_id)
    await db_session.commit()
    plaintext, key_hash = generate_key()
    key = McpApiKey(org_id=org_id, key_hash=key_hash, name="throttle-test")
    db_session.add(key)
    await db_session.commit()
    return plaintext


async def test_rapid_resolution_only_writes_last_used_at_once(db_session, org_and_key):
    """Two resolutions back-to-back (well within the default 5-minute
    throttle) must persist the same last_used_at — the second call
    should skip the write entirely, not just skip re-setting an
    identical-looking in-memory value."""
    first = await resolve_api_key_row(org_and_key, db_session)
    assert first is not None
    first_last_used = first.last_used_at
    assert first_last_used is not None

    # Forces resolve_api_key_row's own SELECT on the second call to
    # actually reflect what's on disk, rather than this test only
    # re-confirming the in-memory identity-mapped object.
    db_session.expire_all()

    second = await resolve_api_key_row(org_and_key, db_session)
    assert second is not None
    assert second.last_used_at == first_last_used


async def test_resolution_after_throttle_window_writes_again(db_session, org_and_key, monkeypatch):
    """Once the throttle window has elapsed, the next resolution must
    write a newer last_used_at."""
    monkeypatch.setattr(api_key_module, "_LAST_USED_THROTTLE", timedelta(seconds=0))

    first = await resolve_api_key_row(org_and_key, db_session)
    assert first is not None
    first_last_used = first.last_used_at

    await asyncio.sleep(0.05)
    db_session.expire_all()

    second = await resolve_api_key_row(org_and_key, db_session)
    assert second is not None
    assert second.last_used_at > first_last_used

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gnt.auth.mcp_keys import hash_key
from gnt.db.models import McpApiKey

# last_used_at only exists to give an admin an approximate "is this key
# still alive" signal — it's never read for anything security- or
# billing-critical. But this function runs on every authenticated
# request, and MCP clients re-resolve their key on every single tool
# call, so writing (and committing) this column unconditionally turns an
# auth check into a DB write per request under real traffic, for no
# product value beyond shaving a few minutes off a timestamp nobody's
# watching closely. 5 minutes is tight enough that the timestamp still
# means something (e.g. confirming a revoked/rotated key actually
# stopped being used, or spotting a key that's gone unexpectedly quiet)
# while collapsing the write volume for any key under sustained traffic.
_LAST_USED_THROTTLE = timedelta(minutes=5)


async def resolve_api_key_row(token: str, session: AsyncSession) -> McpApiKey | None:
    """Looks up the mcp_api_keys row for `token`, or None if it doesn't
    exist, has been revoked, or has expired. Updates last_used_at on
    successful resolution, throttled to at most once per
    _LAST_USED_THROTTLE per key — this is the only place that column is
    ever written."""
    key = (
        await session.execute(select(McpApiKey).where(McpApiKey.key_hash == hash_key(token)))
    ).scalar_one_or_none()
    now = datetime.now(timezone.utc)
    # Same bucket as "revoked" and "doesn't exist" — an expired key
    # returns the identical None/401 either caller sees for those, no
    # separate status or detail message that would tell an attacker
    # (or a confused caller) which of the three actually happened.
    if key is None or key.revoked_at is not None or (key.expires_at is not None and key.expires_at <= now):
        return None
    if key.last_used_at is None or now - key.last_used_at >= _LAST_USED_THROTTLE:
        key.last_used_at = now
        await session.commit()
    return key

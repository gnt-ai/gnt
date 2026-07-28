"""Short-lived distributed locks over the same Redis pool the rate limiter
and job queue already use — for critical sections the underlying engine's store has no
compare-and-swap or row-lock primitive to protect natively (see
routers/rules.py::approve_rule's supersede step).
"""

import uuid

from gnt.queue import get_pool

_RELEASE_SCRIPT = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
"""


async def acquire_lock(key: str, ttl_seconds: int = 10) -> str | None:
    """Best-effort mutual exclusion: SET NX EX is atomic on the Redis side,
    so only one caller ever gets a token back. Returns None if someone else
    currently holds the lock. The TTL is a safety net against a crashed
    holder, not the primary release path (release_lock is)."""
    pool = get_pool()
    token = str(uuid.uuid4())
    acquired = await pool.set(key, token, nx=True, ex=ttl_seconds)
    return token if acquired else None


async def release_lock(key: str, token: str) -> None:
    """Only deletes the lock if we still hold it (GET+DEL as one atomic Lua
    call) — a lock that expired and was re-acquired by someone else must
    never be deleted out from under them."""
    pool = get_pool()
    await pool.eval(_RELEASE_SCRIPT, 1, key, token)

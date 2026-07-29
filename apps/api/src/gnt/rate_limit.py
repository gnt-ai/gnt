import time
import uuid

from fastapi import Depends, HTTPException, Request, status

from gnt.auth.better_auth import OrgContext, get_current_org, require_session
from gnt.config import get_settings
from gnt.queue import get_pool


async def check_rate_limit(key_prefix: str, org_id: str, limit: int) -> bool:
    """Fixed-window limiter keyed per org, backed by the same Redis instance
    as the job queue — no separate dependency, and unlike an in-process
    counter this survives worker restarts and holds across multiple API
    processes. Returns False once `limit` is exceeded for the current
    window. Plain (no FastAPI/HTTPException) so both REST dependencies and
    MCP tools can share the same per-org budget."""
    key = f"{key_prefix}:{org_id}"
    pool = get_pool()
    count = await pool.incr(key)
    if count == 1:
        await pool.expire(key, 3600)
    return count <= limit


_SLIDING_WINDOW_SCRIPT = """
local trimmed = redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1] - ARGV[2])
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[3]) then
    return 0
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
"""


async def check_sliding_window_rate_limit(key: str, limit: int, window_seconds: int) -> bool:
    """A real sliding window (each request is a scored entry in a Redis
    sorted set, entries older than the window get trimmed before
    counting), not the fixed-window budget check_rate_limit above uses —
    the MCP serving layer's per-key limit specifically calls for this,
    since a fixed window lets a caller burst 2x limit across a window
    boundary.

    Trim + count + add run inside a single Lua script so the check is
    atomic on the Redis side — three separate round trips would let
    concurrent requests on the same key all read a stale count and all
    pass, bypassing the limit under load."""
    pool = get_pool()
    now = time.time()
    member = f"{now}:{uuid.uuid4()}"
    allowed = await pool.eval(_SLIDING_WINDOW_SCRIPT, 1, key, now, window_seconds, limit, member)
    return bool(allowed)


async def _enforce_rate_limit(org: OrgContext, key_prefix: str, limit: int) -> OrgContext:
    if not await check_rate_limit(key_prefix, org.org_id, limit):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"rate limit exceeded ({limit}/hour per org)",
        )
    return org


async def enforce_transcribe_rate_limit(org: OrgContext = Depends(get_current_org)) -> OrgContext:
    """Each transcription call is a billed Groq API call, so this is the
    cost backstop, not just abuse prevention."""
    return await _enforce_rate_limit(
        org, "transcribe_rate_limit", get_settings().transcribe_rate_limit_per_hour
    )


async def enforce_cli_key_rate_limit(org: OrgContext = Depends(require_session)) -> OrgContext:
    """Abuse backstop, not a cost backstop like the two above — see
    cli_key_rate_limit_per_hour's own comment in config.py. Depends on
    require_session (not get_current_org), matching create_cli_key's own
    original dependency exactly, so this still closes the self-escalation
    path (an API key minting another, more capable, API key) that
    require_session exists for — it only adds the rate check on top."""
    return await _enforce_rate_limit(
        org, "cli_key_rate_limit", get_settings().cli_key_rate_limit_per_hour
    )


async def enforce_mcp_key_rate_limit(org: OrgContext = Depends(get_current_org)) -> OrgContext:
    """create_mcp_key had no rate limit at all until a security audit
    flagged it as a high-priority gap — get_current_org, not require_session, matching create_mcp_key's
    own original dependency exactly: unlike cli-key minting, an existing API
    key IS allowed to mint another MCP key (create_mcp_key never sets
    is_admin=True regardless of caller, so there's no self-escalation path
    to close here, same reasoning require_session's own docstring gives for
    why THAT function needs the stricter dependency and this one doesn't)."""
    return await _enforce_rate_limit(
        org, "mcp_key_rate_limit", get_settings().mcp_key_rate_limit_per_hour
    )


async def enforce_ip_rate_limit(request: Request, key_prefix: str, limit: int) -> None:
    """The per-IP counterpart to _enforce_rate_limit above, for the handful
    of REST surfaces with no org/session to key on at all (routers/
    webhooks.py's ingest endpoint — see its own module docstring on why it
    skips get_current_org entirely). Not a FastAPI dependency itself (it
    takes key_prefix/limit as plain args, so it can't be passed straight to
    Depends()) — each real caller wraps it in a thin no-arg dependency, same
    shape as enforce_transcribe_rate_limit/enforce_cli_key_rate_limit above,
    so the limit/prefix are baked in at the call site instead of the route
    declaration.

    request.client.host, not a raw X-Forwarded-For header read: uvicorn's
    own --forwarded-allow-ips='*' (see docker-entrypoint.sh) already parses
    that header and rewrites request.client to the real origin IP before
    this ever runs. Safe specifically because Railway's private network is
    the only thing that can reach this container directly, so nothing
    public can spoof the header uvicorn is trusting — see that flag's own
    comment for the full reasoning, which is identical here.

    Reuses check_rate_limit's fixed-window counter verbatim, keyed on the IP
    instead of an org id — that function was already written generically
    enough (see its own docstring) for this to be a straight reuse, not a
    new Redis-backed mechanism."""
    ip = request.client.host if request.client else "unknown"
    if not await check_rate_limit(key_prefix, ip, limit):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"rate limit exceeded ({limit}/hour per IP)",
        )


async def enforce_webhook_ingest_ip_rate_limit(request: Request) -> None:
    """Defense in depth on top of the per-org webhook_ingest_rate_limit —
    that one only ever fires after a token has already resolved to a real
    org, so it does nothing against a script cycling through whk_ token
    guesses (each attempt 401s before the org check runs at all). This
    catches that case, and any other single-source flood, regardless of
    whether the token in a given request is valid. See
    webhook_ingest_ip_rate_limit_per_hour's own comment in config.py for why
    the ceiling is set so much higher than the per-org one."""
    await enforce_ip_rate_limit(
        request, "webhook_ingest_ip_rate_limit", get_settings().webhook_ingest_ip_rate_limit_per_hour
    )

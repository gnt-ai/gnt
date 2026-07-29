import asyncio
import uuid

import pytest
import redis.exceptions
from starlette.requests import Request

from gnt import rate_limit
from gnt.auth.better_auth import OrgContext
from gnt.rate_limit import check_sliding_window_rate_limit


def _fake_request(client_host: str) -> Request:
    """A bare Starlette Request carrying just enough scope for
    request.client.host to resolve — enforce_ip_rate_limit only ever reads
    that one attribute off the real Request FastAPI injects, so this is a
    faithful stand-in without spinning up a full ASGI app for these two
    unit-level tests. test_webhooks.py's own tests exercise the real thing
    end to end through an actual FastAPI dependency-injected app."""
    return Request({"type": "http", "client": (client_host, 0), "headers": []})


async def test_sliding_window_rate_limit_is_atomic_under_concurrency():
    """The three-step trim/count/add used to run as separate Redis round
    trips, so concurrent callers on the same key could all read a stale
    count and all pass — bypassing the limit. Firing the checks
    concurrently here would have let more than `limit` succeed before the
    fix that moved trim+count+add into one atomic Lua script."""
    key = f"rate-limit-atomicity-{uuid.uuid4()}"
    limit = 5

    results = await asyncio.gather(*(check_sliding_window_rate_limit(key, limit, 60) for _ in range(20)))

    assert sum(results) == limit


class _UnreachableRedisPool:
    """Stands in for get_pool() during a Redis outage — every command
    raises the same redis.exceptions.ConnectionError a real client raises
    when it can't reach the server, instead of returning a value."""

    async def incr(self, key):
        raise redis.exceptions.ConnectionError("Error 61 connecting to redis. Connection refused.")

    async def expire(self, key, ttl):
        raise redis.exceptions.ConnectionError("Error 61 connecting to redis. Connection refused.")

    async def eval(self, *args, **kwargs):
        raise redis.exceptions.ConnectionError("Error 61 connecting to redis. Connection refused.")


@pytest.fixture
def unreachable_redis(monkeypatch):
    """Neither check_rate_limit nor check_sliding_window_rate_limit catches
    exceptions from the pool they're handed — get_pool() is patched at the
    rate_limit module level (not gnt.queue) so this covers every caller
    (REST dependencies, MCP tools) regardless of how they imported the
    check function, since they all execute inside rate_limit.py's own
    module namespace and look up get_pool there."""
    monkeypatch.setattr(rate_limit, "get_pool", lambda: _UnreachableRedisPool())


async def test_check_rate_limit_fails_closed_when_redis_unreachable(unreachable_redis):
    """No try/except wraps the pool.incr() call — a Redis outage must raise,
    not silently return True and let an unbounded number of requests
    through. This is the fixed-window limiter transcribe's REST route uses."""
    with pytest.raises(redis.exceptions.ConnectionError):
        await rate_limit.check_rate_limit("transcribe_rate_limit", "org_test", 30)


async def test_check_sliding_window_rate_limit_fails_closed_when_redis_unreachable(unreachable_redis):
    """Same guarantee for the sliding-window limiter the MCP-serving read
    tools (search_rules, get_rule, list_skill_packs, get_skill_pack) use
    for their per-key budget."""
    with pytest.raises(redis.exceptions.ConnectionError):
        await rate_limit.check_sliding_window_rate_limit("mcp_serving_rate_limit:key_test", 100, 3600)


async def test_enforce_transcribe_rate_limit_fails_closed_when_redis_unreachable(unreachable_redis):
    """Same as above for enforce_transcribe_rate_limit, the dependency
    routers/transcribe.py's POST /v1/transcribe uses."""
    org = OrgContext(org_id="org_test", user_id="user_test")
    with pytest.raises(redis.exceptions.ConnectionError):
        await rate_limit.enforce_transcribe_rate_limit(org=org)


async def test_enforce_cli_key_rate_limit_fails_closed_when_redis_unreachable(unreachable_redis):
    """Same guarantee for enforce_cli_key_rate_limit, the dependency
    routers/settings.py's POST /v1/settings/cli-key uses -- a Redis outage
    must reject the mint attempt, not silently let it through unbounded."""
    org = OrgContext(org_id="org_test", user_id="user_test", auth_kind="session")
    with pytest.raises(redis.exceptions.ConnectionError):
        await rate_limit.enforce_cli_key_rate_limit(org=org)


async def test_enforce_webhook_ingest_ip_rate_limit_fails_closed_when_redis_unreachable(
    unreachable_redis,
):
    """Same fail-closed guarantee for the per-IP limiter on
    routers/webhooks.py's ingest endpoint. Real
    request-blocking behavior (limit reached, different IPs stay
    independent) is proven end to end in test_webhooks.py against a real
    FastAPI app; this one is specifically about the Redis-outage path,
    matching every other enforce_* test in this file."""
    request = _fake_request("203.0.113.9")
    with pytest.raises(redis.exceptions.ConnectionError):
        await rate_limit.enforce_webhook_ingest_ip_rate_limit(request=request)


async def test_enforce_ip_rate_limit_keys_on_request_client_host():
    """The one behavioral thing worth unit-testing directly (rather than
    only through a real app, which test_webhooks.py already covers): two
    different client hosts never share a counter, and the same host is
    exactly one shared counter — proven here without needing a full ASGI
    round trip per call."""
    key_prefix = f"ip-rate-limit-test-{uuid.uuid4()}"
    host_a = "203.0.113.1"
    host_b = "203.0.113.2"

    # Same IP, same budget: two calls against a limit of 2 both succeed,
    # the third is rejected.
    await rate_limit.enforce_ip_rate_limit(_fake_request(host_a), key_prefix, 2)
    await rate_limit.enforce_ip_rate_limit(_fake_request(host_a), key_prefix, 2)
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        await rate_limit.enforce_ip_rate_limit(_fake_request(host_a), key_prefix, 2)
    assert exc_info.value.status_code == 429

    # A different IP under the same key_prefix has its own, untouched budget.
    await rate_limit.enforce_ip_rate_limit(_fake_request(host_b), key_prefix, 2)

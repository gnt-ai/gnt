from arq import ArqRedis, create_pool
from arq.connections import RedisSettings

from gnt.config import get_settings

_pool: ArqRedis | None = None


async def init_pool() -> None:
    global _pool
    _pool = await create_pool(RedisSettings.from_dsn(get_settings().redis_url))


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.aclose()
        _pool = None


def get_pool() -> ArqRedis:
    if _pool is None:
        raise RuntimeError("arq pool not initialized")
    return _pool


async def enqueue_compile(org_id: str) -> None:
    """Debounced per-org skill-pack compile — dedupes on job id so a burst
    of rule approvals for the same org collapses to one compile instead of
    one per merge."""
    await get_pool().enqueue_job(
        "compile_skills",
        org_id,
        _job_id=f"compile:{org_id}",
        _defer_by=get_settings().compile_debounce_seconds,
    )

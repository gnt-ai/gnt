"""Worker concurrency cap. There isn't much to
meaningfully exercise behaviorally here (that would mean actually running
arq's Worker loop against a live Redis with real jobs, well past what a
config value earns) — this confirms WorkerSettings carries a deliberate,
non-default max_jobs, per that setting's own comment in config.py."""

from gnt.config import get_settings
from gnt.workers.worker import WorkerSettings


def test_worker_max_jobs_is_set_to_a_deliberate_bounded_value():
    # arq's own Worker class defaults max_jobs to 10 when a WorkerSettings
    # doesn't set it at all -- asserting against config.py's own value
    # (not the literal 10) proves this is wired to the founder-tunable
    # setting rather than a hardcoded number that could drift out of sync,
    # and the != 10 check proves it's not silently just re-deriving arq's
    # own library default by coincidence.
    assert WorkerSettings.max_jobs == get_settings().worker_max_concurrent_jobs
    assert WorkerSettings.max_jobs != 10
    assert 1 <= WorkerSettings.max_jobs <= 50

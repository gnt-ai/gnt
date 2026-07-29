from arq import cron
from arq.connections import RedisSettings

from gnt.config import get_settings
from gnt.workers.tasks_compile import compile_skills
from gnt.workers.tasks_contradictions import sweep_contradictions
from gnt.workers.tasks_digest import send_all_weekly_digests
from gnt.workers.tasks_intercom import sync_intercom
from gnt.workers.tasks_staleness import compute_rule_staleness
from gnt.workers.tasks_zendesk import sync_zendesk


class WorkerSettings:
    functions = [compile_skills]
    # Convention for anything added here: a cron job takes no arguments
    # (arq schedules it globally, nothing passes it an org_id) and must
    # iterate every org itself — never one unscoped/cross-org statement.
    # Enumerate org ids through gnt_cron (get_cron_sessionmaker(),
    # BYPASSRLS) since orgs itself is RLS-protected and there's nothing
    # to scope_to_org() with yet, then do the actual per-org read/write
    # through a normal scope_to_org'd session, one org at a time — see
    # tasks_staleness.py's compute_rule_staleness for the reference
    # implementation and its module docstring for why. Pick a schedule
    # that's off-peak and reasonably spaced from the others below.
    #
    # sweep_contradictions runs at 4:30, ninety minutes after staleness's
    # 3:00 — enough room for that job to finish on a normal-sized org
    # before this one starts making its own store calls, and no two
    # nightly LLM-cost jobs land on the same cron tick.
    #
    # send_all_weekly_digests runs Monday 8:00 — a "start of week" number,
    # not a nightly job like the others, and deliberately after all the
    # nightly sweeps: it reads roi_counters/rule_gaps/rule_staleness, none
    # of which it writes, but a digest built right after Sunday-night's
    # runs (which land hours earlier, still nightly) reflects the freshest
    # numbers rather than a run from up to a week ago.
    #
    # sync_zendesk runs at 2:00, an hour ahead of staleness's 3:00 — its
    # own draft-rule creation (and, when GitHub is connected, PR opening)
    # has no read/write overlap with any of the other jobs, so the only
    # thing that matters is not landing on the same tick. sync_intercom is
    # the same shape of job (own org loop, own draft-rule creation) and
    # got its own 2:30 slot rather than sharing Zendesk's 2:00 — "no two
    # nightly LLM-cost jobs land on the same cron tick" is this file's own
    # standing rule (see sweep_contradictions's offset from staleness
    # above), and two support-connector syncs are exactly the same class
    # of job that rule exists to keep off each other's tick.
    cron_jobs = [
        cron(sync_zendesk, hour=2, minute=0),
        cron(sync_intercom, hour=2, minute=30),
        cron(compute_rule_staleness, hour=3, minute=0),
        cron(sweep_contradictions, hour=4, minute=30),
        cron(send_all_weekly_digests, weekday="mon", hour=8, minute=0),
    ]
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
    # Worker concurrency cap. Previously unset (arq's own library default
    # of 10 was the only thing bounding this). See worker_max_concurrent_jobs's
    # own comment in config.py for why 8.
    max_jobs = get_settings().worker_max_concurrent_jobs

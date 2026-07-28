from functools import lru_cache

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Every "change-me..." placeholder in .env.example (DATABASE_URL/
    # CRON_DATABASE_URL's password, CONTRIBUTOR_HASH_SECRET,
    # SLACK_STATE_SECRET/TOKEN_ENCRYPTION_KEY, GITHUB_PAT_ENCRYPTION_KEY,
    # STORE_INTERNAL_API_SECRET, APPROVAL_SIGNING_SECRET, and any future
    # connector's own encryption key that follows the same convention) is
    # a real secret a deploy must generate, not a value anything should
    # ever actually run with — a customer's Slack/GitHub/support tokens
    # would decrypt under a key copy-pasted straight out of a public
    # example file. get_settings() below is called at import time by both
    # main.py (sentry_sdk.init) and workers/worker.py, so this fires
    # before either process can serve a single request or job, in local
    # dev, CI, and production alike. CI/local-dev fixtures use their own
    # "ci-placeholder"/real-generated-secret conventions (see
    # .github/workflows/ci.yml, tests/conftest.py), never this literal
    # string, so this can't false-positive against a legitimate test run.
    @model_validator(mode="after")
    def _reject_unreplaced_placeholders(self) -> "Settings":
        offenders = sorted(
            name for name, value in self.__dict__.items() if isinstance(value, str) and "change-me" in value
        )
        if offenders:
            raise ValueError(
                "refusing to start: these settings still have their .env.example placeholder value, "
                f"generate real secrets for them first: {', '.join(offenders)}"
            )
        return self

    # The app's own runtime connection (FastAPI request handlers, ARQ
    # workers) — should be the restricted gnt_app role (see migration 0013),
    # not a superuser or table owner. FORCE ROW LEVEL SECURITY only closes
    # the table-owner-bypasses-RLS gap; a genuine Postgres superuser
    # bypasses RLS regardless of FORCE, no exception.
    database_url: str
    # DDL connection for `alembic upgrade` — needs CREATE/ALTER rights
    # gnt_app deliberately doesn't have. Falls back to database_url so
    # nothing breaks for anyone who hasn't set up the role split yet, but
    # that fallback only works if database_url is still a privileged role;
    # once it's gnt_app, this must be set or migrations fail (correctly —
    # DDL against a role with no DDL rights should fail loudly, not
    # silently no-op).
    #
    # Must be a genuine Postgres superuser, not merely a schema/table
    # owner with broad DDL grants: migration 0014's CREATE ROLE ... WITH
    # BYPASSRLS is one of the few operations Postgres reserves to actual
    # superusers specifically — a non-superuser role, even with CREATEROLE,
    # cannot grant an attribute it doesn't itself have. This fails loudly
    # (a clear Postgres permission error) if violated, unlike the
    # cron_database_url gap below.
    migration_database_url: str | None = None
    # gnt_cron (migration 0014) — BYPASSRLS, for genuinely cross-org or
    # pre-org-resolution work (currently: routers/billing.py's Stripe
    # webhook, which has to look an org up by stripe_subscription_id before
    # it knows an org_id to scope_to_org() with). Deliberately no fallback
    # to database_url in code (see db/session.py's get_cron_engine) —
    # unlike migration_database_url, a missing gnt_cron connection wouldn't
    # fail loudly: gnt_app's DML grants are valid, so a write here would
    # just silently match zero rows under RLS instead of erroring.
    cron_database_url: str | None = None
    # gnt_admin (migration 0035) — BYPASSRLS, SELECT-only except for a
    # column-scoped UPDATE on orgs.plan_tier/subscription_status. Backs the
    # internal platform-admin dashboard's cross-org reads and its one
    # explicit comp-a-plan-tier write. Same "no fallback to database_url"
    # reasoning as cron_database_url — see db/session.py's get_admin_engine.
    admin_database_url: str | None = None
    redis_url: str = "redis://localhost:6379/0"

    # Optional: if unset, the Anthropic SDK falls back to ANTHROPIC_AUTH_TOKEN
    # or an `ant auth login` profile.
    anthropic_api_key: str | None = None
    groq_api_key: str

    # whisper-large-v3-turbo — fast + cheap (~$0.04/hr audio), used for
    # server-side voice-input transcription. Browser Web Speech API dictation
    # (webkitSpeechRecognition) turned out to be unreliable industry-wide —
    # persistent "network" errors unrelated to actual connectivity — so
    # transcription moved server-side instead of trying to work around that.
    transcribe_model: str = "whisper-large-v3-turbo"
    # Groq's free-tier cap is 25MB; stay comfortably under it so a bad
    # recording fails fast with a clear error instead of a slow rejection.
    transcribe_max_file_size_bytes: int = 20 * 1024 * 1024
    transcribe_rate_limit_per_hour: int = 60

    contributor_hash_secret: str

    # Abuse backstop on POST /v1/settings/cli-key (gnt login's minting
    # endpoint) — not a cost concern like transcribe above, since minting a
    # key is cheap. It's here because a live session can mint unlimited
    # admin-snapshotting CLI credentials otherwise (see create_cli_key's own
    # docstring on why this is the one path that ever sets is_admin=True).
    # A real user logs in at most a handful of times a day, so 10/hour per
    # org is generous headroom over normal use while still bounding a
    # compromised session or a scripted abuse loop.
    cli_key_rate_limit_per_hour: int = 10

    # fix-plan-v3 item C2 — key expiry and rotation. Applied to newly
    # minted CLI keys only (create_cli_key), not MCP keys (create_mcp_key
    # leaves expires_at null) — see settings.py's create_mcp_key comment
    # for why the plan's "for new CLI keys" default doesn't extend there.
    # 90 days is the plan's own recommended default, confirmed by the
    # founder.
    cli_key_default_ttl_days: int = 90

    # fix-plan-v2 item 14 — generic webhook ingestion (routers/webhooks.py).
    # This one's a real abuse vector, not just cost: unlike cli_key_rate_
    # limit_per_hour above (gated on a live session), a webhook token sits
    # in a Zapier/monday/HubSpot config and gets called by a third-party
    # service on its own schedule, so a misconfigured Zap looping (or a
    # leaked token) could flood an org's draft-rule queue. 100/hour is
    # generous for real comment-stream volume while still bounding a loop.
    webhook_ingest_rate_limit_per_hour: int = 100

    # v3 fix-plan Tier 0 audit finding: create_mcp_key had no rate limit at
    # all, unlike its cli-key sibling above. Same abuse-backstop reasoning
    # as cli_key_rate_limit_per_hour (minting a key is cheap, this bounds a
    # scripted loop rather than cost) — higher ceiling than that one since
    # an org legitimately mints one MCP key per agent/integration it wires
    # up, not just per human login.
    mcp_key_rate_limit_per_hour: int = 30

    # v3 fix-plan Tier 0 (C9b) — per-IP backstop on the webhook ingest
    # endpoint, on top of webhook_ingest_rate_limit_per_hour above. That
    # limit is keyed per org (resolved from the token), so it does nothing
    # for a caller who doesn't have a valid token yet — e.g. a script
    # brute-forcing whk_ token guesses, which fails token lookup every time
    # and never reaches the per-org check at all. Keyed per source IP
    # instead, so it catches that case regardless of which (if any) org a
    # given request's token belongs to. Deliberately much higher than the
    # per-org limit: Zapier/monday/HubSpot's outbound webhook traffic comes
    # from shared infrastructure IPs used by many unrelated customers at
    # once (not just gnt's), so this has to stay generous enough to never
    # throttle legitimate multi-tenant automation traffic — it's a backstop
    # against a single flooding/brute-forcing source, not a primary throttle.
    webhook_ingest_ip_rate_limit_per_hour: int = 1000

    # v3 fix-plan Tier 0 (C9b) — "capture/storage ceilings". With the old
    # capture pipeline retired, unbounded draft-rule creation is the closest
    # live equivalent: both POST /v1/rules and the webhook ingest endpoint
    # write status="draft" rules through create_draft_rule with nothing
    # capping how many accumulate. A runaway webhook loop or scripted abuse
    # could otherwise flood an org's draft queue indefinitely even while
    # staying under the hourly rate limits above (100/hour sustained for a
    # week is 16,800 drafts). 500 is well above any real review backlog (a
    # human/agent working through drafts keeps this nowhere close) while
    # still being a real ceiling — cheap validation-phase default, tune up
    # if a legitimate org ever approaches it faster than it can review.
    max_draft_rules_per_org: int = 500

    # fix-plan-v3 2.4 — batch-propose (routers/rules.py) opens one PR for
    # several rules at once. The plan's own recommended batch size is 5-8
    # rules per PR grouped by topic (gnt prebrain's own grouping heuristic
    # targets that range) — this is a server-side ceiling above that
    # target, not the target itself, so a legitimately larger topic group
    # doesn't get rejected while still bounding a single PR (and a single
    # branch's worth of put_file calls) from growing unbounded.
    max_rules_per_batch_propose: int = 20


    # apps/web's own public base URL. Doubles as the Better Auth jwt
    # plugin's "iss"/"aud" claim value (apps/web/lib/auth.ts doesn't
    # override either) and the base for its JWKS endpoint — see
    # auth/better_auth.py. Reusing this instead of a separate setting
    # means there's nothing that can drift out of sync with the CORS
    # origin below.
    web_origin: str = "http://localhost:3000"
    # This API's own public origin — needed to build the exact redirect_uri
    # sent to Slack's OAuth authorize/token endpoints, which must byte-for-
    # byte match what's registered in the Slack app's settings.
    api_origin: str = "http://localhost:8000"
    # Extra hostnames the MCP server's dns-rebinding check accepts besides
    # api_origin's own — comma-separated. Exists for the legacy
    # .up.railway.app domain: RAILWAY_PUBLIC_DOMAIN repoints to the custom
    # domain the moment one is attached, so the old host isn't derivable
    # from any env Railway still provides (learned the hard way — see
    # mcp_server/server.py's allowlist comment).
    mcp_extra_allowed_hosts: str = ""

    # Skill packs compile `debounce_seconds` after a rule is approved
    # (github_webhook.py's merge handler enqueues the compile job) — dedupes
    # on job id, so several merges close together collapse into one compile.
    compile_debounce_seconds: int = 600

    # v3 fix-plan Tier 0 (C9b) — worker concurrency cap (workers/worker.py's
    # WorkerSettings.max_jobs). Previously unset, which left arq's own
    # library default (10) as the effective cap rather than a deliberate
    # choice — a burst of enqueued jobs (the nightly cron jobs plus however
    # many compile_skills jobs are debounced-and-ready at once, one per org
    # with a recent approval) had no documented reason to stay under any
    # particular number. 8 keeps a small margin under that library default
    # so the single-container worker this runs on (see docker-entrypoint.sh)
    # never has more than a handful of org-scoped jobs — each of which opens
    # its own DB session and, for the nightly sweeps, makes LLM calls —
    # running fully in parallel. Raise once the worker actually needs to run
    # on beefier or multiple containers.
    worker_max_concurrent_jobs: int = 8

    # Rule-conflict check propose_rule runs before opening a PR (git-native
    # rules — see pipeline/rule_conflict.py). Cheapest tier for now
    # (validation phase) — Haiku 4.5 is ~3-5x cheaper than Sonnet 5 per
    # token; swap back to claude-sonnet-5 once past validation.
    rule_merge_model: str = "claude-haiku-4-5"

    # The LLM judge behind check_action (the enforcement tool — see
    # action_check.py). Haiku-class on purpose: check_action runs inline in
    # an agent's action path, so the whole call (retrieval + this judge) has
    # to stay under a ~2s p95 budget, and the judge is a narrow grounded
    # yes/no/escalate decision over already-retrieved rule text, not open
    # generation. Same tier as rule_merge_model above.
    check_action_model: str = "claude-haiku-4-5"

    # Nightly contradiction sweep (fix-plan-v2 item 13 — workers/
    # tasks_contradictions.py). Two separate budgets, not one, because a
    # judge_conflict call and a filed GitHub issue cost different things:
    # comparisons is the per-org cap on rule_merge_model calls the sweep
    # spends judging candidate pairs (an already-flagged pair is skipped
    # for free and doesn't count against this); issues is a separate,
    # smaller cap on how many new issues the sweep opens in a customer's
    # rules repo in one night, so a corpus with a lot of genuine
    # contradictions doesn't dump dozens of issues on a repo at once.
    # Founder-tunable, same "numeric knob in Settings" convention as
    # transcribe_rate_limit_per_hour/cli_key_rate_limit_per_hour above —
    # both are cheap defaults for the validation phase, not a claim that
    # this is the right number at scale.
    contradiction_sweep_max_comparisons_per_org: int = 20
    contradiction_sweep_max_issues_per_org: int = 5

    # C9a (fix-plan-v3 Tier 0 prerequisite 0.1) — per-org monthly LLM
    # spend quota, and the global aggregate circuit breaker cap. See
    # gnt.llm_quota for enforcement/recording and the three call sites it
    # gates (action_check, rule_conflict, the nightly contradiction
    # sweep). Cheap defaults for the validation phase, same
    # "founder-tunable numeric knob, not a claim it's right at scale"
    # convention as contradiction_sweep_max_comparisons_per_org above:
    # check_action_model/rule_merge_model are both Haiku-tier
    # (~$1/$5 per MTok), so a handful of orgs kicking the tires
    # comfortably fits inside these numbers without either cap tripping
    # on legitimate use. The 50/80/100 percent alert checkpoints
    # themselves are NOT a separate setting — they're the plan's own
    # explicit numbers (fix-plan-v3 item 0.1: "founder alerts at
    # 50/80/100 percent"), not this codebase's judgment call, so
    # there's nothing to tune per-deploy; see gnt.llm_quota's
    # _ALERT_THRESHOLDS.
    llm_monthly_quota_per_org_usd: float = Field(default=5.0, ge=0)
    llm_global_monthly_cap_usd: float = Field(default=50.0, ge=0)

    # Slack connector — OAuth install (routers/slack.py, gnt/slack/oauth.py)
    # plus the /brain slash command. Client id/secret/signing secret come
    # from a Slack app the user creates themselves; state secret and token
    # encryption key are generated locally, never shared with Slack.
    slack_client_id: str
    slack_client_secret: str
    slack_signing_secret: str
    slack_state_secret: str
    slack_token_encryption_key: str

    # GitHub connector (git-native rules storage) — a PAT-based connect flow
    # per org. Own dedicated encryption key, not slack_token_encryption_key —
    # a PAT with write access to a customer's rules repo is a materially
    # higher-value secret than a Slack bot token scoped to commands/chat/im
    # only. Kept alongside the GitHub App settings below, not removed —
    # existing PAT-connected orgs keep working unchanged until they run
    # `gnt connect github --upgrade`; see gnt/github/app_auth.py's
    # get_repo_token for where the two flows converge.
    github_pat_encryption_key: str

    # GitHub App (replaces the PAT flow above as the default connect path —
    # fine-grained permissions, auto-managed webhooks, hourly-expiring
    # installation tokens instead of a long-lived PAT sitting in Postgres).
    # App ID and client ID are public — GitHub shows both on the app's own
    # settings page, safe to log/reference. Optional, same "unset = this
    # integration isn't live yet" convention as stripe_secret_key/
    # resend_api_key above, not github_pat_encryption_key's required-string
    # convention — CI/local dev don't need a real RSA keypair just to import
    # this module, and every call site that actually mints a JWT or verifies
    # an App webhook fails loud (GithubAppError), not silently, if these are
    # unset when genuinely needed. No dedicated Fernet key here unlike the
    # PAT/Zendesk/Intercom connectors above — nothing App-related ever gets
    # encrypted-and-stored; installation_id is stored on GithubConnection in
    # plaintext (it's an identifier, not a secret, same as repo_url), and
    # the private key/webhook secret are read straight from env at request
    # time (JWT minting, signature verification) and never persisted.
    github_app_id: str | None = None
    github_app_client_id: str | None = None
    github_app_private_key: str | None = None
    github_app_webhook_secret: str | None = None

    # Zendesk connector (connector sprint T4.2) — continuous server-side
    # sync, not a CLI-local one-shot (founder decision, 2026-07-18, see
    # workers/tasks_zendesk.py's module docstring). Self-serve API token a
    # customer generates in their own Zendesk admin, no OAuth app review.
    # Own dedicated encryption key, same reasoning as github_pat_encryption_key
    # being separate from slack_token_encryption_key above: a Zendesk token
    # can read a customer's ticket/help-center content, a different value
    # tier than a Slack bot token scoped to commands/chat/im only, so it
    # doesn't share a key with either existing connector.
    zendesk_token_encryption_key: str

    # Nightly Zendesk sync (workers/tasks_zendesk.py). Same "founder-tunable
    # numeric knob, cheap default for the validation phase" convention as
    # contradiction_sweep_max_comparisons_per_org above — bounds how many
    # content items (macros + changed tickets' internal notes + articles,
    # combined) one org's sync spends an extraction call on per run, so a
    # large Zendesk instance's first sync doesn't attempt to extract its
    # entire macro library and ticket history in one pass.
    zendesk_sweep_max_items_per_org: int = 50

    # Notion connector (OAuth sprint T14 dashboard track) — a real OAuth
    # app, unlike Slack's, needs no vendor-side app review to acquire:
    # notion_client_id/secret came from Notion's own dynamic client
    # registration endpoint (mcp.notion.com/register, RFC 7591 — the same
    # discovery flow the CLI's own managed-OAuth connectors already use,
    # see apps/cli/src/prebrain/mcp-framework/connect.ts's
    # MANAGED_OAUTH_TOKEN), registered once against this API's own
    # redirect_uri and then treated as a normal long-lived client id/secret
    # pair from here on, same shape as slack_client_id/secret above. State
    # secret and token encryption key are generated locally, same
    # convention as every other connector's.
    notion_client_id: str
    notion_client_secret: str
    notion_state_secret: str
    notion_token_encryption_key: str

    # Linear connector (OAuth sprint T14 dashboard track) — reuses the same
    # "gnt CLI" OAuth app already registered at linear.app/settings/api/
    # applications for the CLI's own loopback-redirect flow
    # (connect-linear-mcp.ts), with this API's redirect_uri added as a
    # second registered Redirect URI on that same app. No client secret:
    # Linear's PKCE flow makes it optional (see LocalRedirectOAuthConfig's
    # own doc comment in oauth.ts for the identical CLI-side reasoning),
    # and a server-held secret buys nothing PKCE doesn't already cover
    # here, so gnt/linear/oauth.py never sends one.
    linear_client_id: str
    linear_state_secret: str
    linear_token_encryption_key: str

    # Intercom connector (connector sprint T4.3) — continuous server-side
    # sync, same architecture as Zendesk's (T4.2, see
    # workers/tasks_intercom.py's module docstring). Self-serve Personal
    # Access Token a customer generates in their own workspace's Developer
    # Hub, no OAuth app review. Own dedicated encryption key, same
    # reasoning as zendesk_token_encryption_key/github_pat_encryption_key
    # above being separate from each other and from Slack's: an Intercom
    # token can read a customer's saved replies, conversation notes, and
    # help-center content, a different value tier than a Slack bot token
    # scoped to commands/chat/im only, so it doesn't share a key with any
    # other connector.
    intercom_token_encryption_key: str

    # Nightly Intercom sync (workers/tasks_intercom.py) — same founder-
    # tunable-knob convention zendesk_sweep_max_items_per_org establishes,
    # its own separate cap rather than sharing Zendesk's, since the two
    # connectors' orgs and content volumes are independent of each other.
    intercom_sweep_max_items_per_org: int = 50

    # Haiku-tier, same reasoning as check_action_model/rule_merge_model
    # above — turning one piece of already gate-masked support prose into
    # zero or more candidate rules is a narrow, grounded extraction task,
    # not open generation. Must stay one of llm_quota's priced models
    # (gnt.llm_quota._MODEL_PRICING_PER_MTOK_USD) or spend tracking falls
    # back to the conservative Sonnet-tier estimate. Shared across every
    # connector that reads ambient third-party support prose (Zendesk,
    # Intercom, ...) — see pipeline/content_extraction.py's own module
    # docstring for why that module is deliberately connector-agnostic.
    content_extraction_model: str = "claude-haiku-4-5"

    # Execution plan Phase 2 — MCP serving layer over the rules table.
    search_rules_similarity_threshold: float = 0.4
    search_rules_result_limit: int = 10
    # Per-key, not per-org — an org with several keys (e.g. one per
    # deployed agent) shouldn't have one noisy integration exhaust the
    # budget for the others.
    mcp_rate_limit_per_key: int = 100
    mcp_rate_limit_window_seconds: int = 3600

    # Migration Phase 4 — apps/store is the internal API in front of the
    # engine-backed seam. store_internal_api_secret authenticates every
    # call to it (a different secret from approval_signing_secret, which
    # authorizes specifically an approved-status write — see
    # apps/store/src/http/server.ts's own comment on why these are two
    # separate secrets, not one).
    store_api_url: str = "http://127.0.0.1:8787"
    store_internal_api_secret: str
    approval_signing_secret: str
    store_http_timeout_seconds: float = 10.0

    # M6 hardening — error monitoring. Optional: unset (the default) means
    # sentry_sdk.init(dsn=None) below, which is a documented no-op — local
    # dev and CI never need this configured. No traces_sample_rate is set
    # deliberately (performance tracing stays off, not needed yet), and
    # send_default_pii is left at the SDK's own default (False) rather than
    # opted into — this project's whole design minimizes what raw user
    # data leaves the system (see docs/migration's privacy sections), and
    # shipping request IPs/headers to a third party by default would cut
    # against that without a deliberate reason to.
    sentry_dsn: str | None = None

    # Monetization — two tiers now: base ($29/mo, stripe_price_id, 1500
    # check_action calls/month) and pro ($149/mo, stripe_price_id_pro, 8000
    # calls/month — also the only tier that allows multi-org membership,
    # see apps/web/lib/auth.ts). The cap numbers themselves live in
    # gnt/plan_limits.py, not here — that's product logic, this is just
    # which Stripe Price each tier checks out against. Optional so existing
    # dev/CI setups without Stripe configured keep working —
    # routers/billing.py fails loud, not silently, if a checkout/portal
    # call is attempted without these set. stripe_price_id_pro can stay
    # unset without breaking the base tier; checkout for "pro" fails loud
    # the same way an unconfigured stripe_price_id already does.
    stripe_secret_key: str | None = None
    stripe_webhook_secret: str | None = None
    stripe_price_id: str | None = None
    stripe_price_id_pro: str | None = None
    billing_trial_days: int = Field(default=14, ge=0)

    # Weekly digest email (fix-plan-v2 item 10 — workers/tasks_digest.py,
    # gnt/email.py). Same Resend account apps/web/lib/email.ts already uses
    # for Better Auth's login OTP/invite emails, but a separate pair of
    # settings here — apps/web reads these two straight from process.env on
    # Vercel; apps/api runs on Railway's api/worker services, which don't
    # have them set yet (founder to add before real digest emails send).
    # Optional, same "unset = the integration just isn't live yet" pattern
    # as stripe_secret_key above: gnt.email.is_email_configured() gates on
    # this, and the digest cron job logs clearly and skips sending rather
    # than crashing when it's absent — the rest of item 10 (the ROI
    # aggregation itself, `gnt status`) works with zero email capability.
    resend_api_key: str | None = None
    # Mirrors email.ts's FROM_EMAIL fallback exactly — gntai.dev is verified
    # in Resend (DKIM/SPF/DMARC records live), a real sending address.
    resend_from_email: str = "gnt.ai <notifications@gntai.dev>"

    # The one published, customer-facing MCP endpoint (gnt.ai fix plan v2,
    # item 4/5) — every place that shows this URL to a customer (CLI output,
    # docs, README) derives it from here instead of hand-building the string,
    # so there's exactly one thing that can drift.
    @property
    def mcp_url(self) -> str:
        return f"{self.api_origin}/mcp"

    # Comma-separated allowlist for the internal platform-admin dashboard —
    # a signed-in user whose email is on this list can view/manage every
    # org across the platform (auth/better_auth.py's require_platform_admin).
    # Deliberately just an env var, not a DB column or role system: this is
    # a founder-only tool today, not a support team, so a real RBAC model
    # is unwarranted until that changes.
    platform_admin_emails: str = ""

    @property
    def platform_admin_email_set(self) -> set[str]:
        return {email.strip().lower() for email in self.platform_admin_emails.split(",") if email.strip()}


@lru_cache
def get_settings() -> Settings:
    return Settings()

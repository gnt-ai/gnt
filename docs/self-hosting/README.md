# Self-hosting gnt

Everything on this page was actually run against `docker-compose.yml` on this
machine (macOS, Colima-backed Docker) while writing it — `docker compose
build` → `docker compose run --rm api uv run alembic upgrade head` →
`docker compose up -d` → poll `/healthz`, twice, from a clean volume, before
this doc was written. One real bug got found and fixed in the process (see
"A bug this doc found" below); everything else here reflects what actually
happened, not what should happen.

**What this gets you**: the API (git-native rules pipeline, MCP server),
the background worker (skill-pack compiler, cron jobs), and the store
(rules storage + approval gate — `STORE_BACKEND=native`, gnt's own
storage/retrieval, no third-party knowledge-store dependency). **What it
doesn't include**: `apps/web`, the marketing site and dashboard —
self-hosting gnt means running the API and MCP server, not the public
website. That has one real consequence worth knowing before you start: see
"First login" below.

## Fast path

Want to evaluate the product before configuring a deployment? From a fresh
clone, `./demo.sh` boots an isolated stack, seeds a real approved rule, calls
the MCP `check_action` tool, and prints a reusable curl command. It needs only
Docker; an Anthropic key is optional because a missing key demonstrates gnt's
real fail-closed `needs_human` behavior. Demo data lives under the separate
`gnt-demo` Compose project and never shares the normal self-host volume.

```bash
git clone https://github.com/gnt-ai/gnt
cd gnt
./demo.sh
```

When you are ready to configure a persistent self-hosted deployment instead,
run `./setup.sh`; that is the path described in the sections below.

`setup.sh` does everything sections 1 and 2 below do by hand: copies both
`.env` files, generates every secret it safely can, asks for the three keys
it can't (Anthropic, Groq, ZeroEntropy — the rest of this page's env vars
are connector-specific or optional, see "What's actually required" below),
then builds, migrates, and boots the stack. It's safe to re-run. If
something goes wrong, or you'd rather see each step happen, the rest of
this page is that same sequence run by hand.

## What's actually required

Two kinds of env var live in `apps/api/.env` and `apps/store/.env`:
secrets gnt needs but can generate for itself (Fernet keys, the shared
secret `apps/api` and `apps/store` use to authenticate to each other —
`setup.sh` handles all of these), and connector credentials
(Slack/GitHub/Zendesk/Notion/Linear/Intercom) that are only exercised once
you actually connect that integration — leave them as placeholders until
you do.

What's left is three keys nothing can generate for you, and gnt won't
really do anything without them:

- **`ANTHROPIC_API_KEY`** — runs the rule-conflict check and `check_action`,
  the actual point of gnt. Get one at
  [console.anthropic.com](https://console.anthropic.com/settings/keys).
- **`GROQ_API_KEY`** — server-side voice-input transcription. The API
  container won't start without *some* value here (no pydantic default),
  but nothing calls it unless a request hits `/v1/transcribe` — a
  placeholder boots fine if you don't need voice input yet. Free tier at
  [console.groq.com](https://console.groq.com).
- **`ZEROENTROPY_API_KEY`** (in `apps/store/.env`) — embeddings/reranking
  for rule search. The store process boots without it, but any call that
  actually embeds or reranks a rule fails at request time. Get one at
  [zeroentropy.dev](https://zeroentropy.dev).

`setup.sh` asks for all three up front and tells you which ones are still
placeholders when it finishes — connect the rest (Slack, GitHub, etc.)
once the stack is actually running. Full field-by-field reference for
everything else: [`env-vars.md`](./env-vars.md).

## Prerequisites

- Docker + Compose. This was verified with `docker-compose` (the standalone
  v2 binary, `docker-compose version` → `Docker Compose version 5.3.1`), not
  the `docker compose` plugin — this sandbox didn't have the plugin
  installed. Either works; substitute whichever `docker compose` /
  `docker-compose` binary you have for every command below.
- `openssl` (secret generation) and `python3` with `cryptography` installed
  somewhere on your machine, or a running `apps/api` checkout with `uv sync`
  already done — you need it once, to generate the Fernet-format encryption
  keys (see env-vars.md).
- A GitHub repo you're willing to open real PRs against for rules.

## 1. Clone and configure

`setup.sh` does this step for you. By hand:

```bash
git clone https://github.com/gnt-ai/gnt
cd gnt
cp apps/api/.env.example apps/api/.env
cp apps/store/.env.example apps/store/.env
```

Fill in every value in both files. Full field-by-field reference (types,
defaults, which are actually required to boot — generated from the real
`Settings` model, not hand-typed): [`env-vars.md`](./env-vars.md). The short
version — see "What's actually required" above for the three keys that
matter most:

- Every `change-me-...` placeholder must become a real generated secret —
  `apps/api/src/gnt/config.py`'s `Settings` model refuses to construct
  (the api container refuses to start) if any field still holds its
  `.env.example` value. (`setup.sh` generates every one of these for you.)
- The Slack/GitHub-PAT/Zendesk/Notion/Linear/Intercom connector fields are
  all **required to boot even if you never use that connector** — they're
  plain `str` fields with no default in `Settings`. Fill each with a
  throwaway placeholder unless you're actually wiring that integration up.
  (`apps/api/.env.example`'s own `...` placeholders already satisfy this —
  nothing to do here unless you're connecting one for real.)
- `GROQ_API_KEY` is required too (server-side voice-transcription) — see
  "What's actually required" above.
- `apps/store/.env.example` includes `ZEROENTROPY_API_KEY` — required for
  rule search to actually work, not to boot. `native/embed.ts` and
  `native/rerank.ts` read it directly via `process.env.ZEROENTROPY_API_KEY`.

## 2. Build, migrate, boot

`setup.sh` does this step for you too. By hand:

```bash
docker compose build
docker compose run --rm api uv run alembic upgrade head   # one-time, before first start
docker compose up -d
```

Verified output from a clean volume (`docker-compose` standalone binary,
substitute `docker compose` for the plugin form):

```
$ docker-compose run --rm api uv run alembic upgrade head
...
INFO  [alembic.runtime.migration] Running upgrade 0034 -> 0035, Creates gnt_admin — a third, narrow-purpose role for the internal
platform-admin dashboard (founder-only, cross-org visibility into every
org: plan tier, usage, spend, rules, gaps, connectors, members).

$ docker-compose up -d
 Container ...-postgres-1  Healthy
 Container ...-redis-1     Healthy
 Container ...-store-1     Started
 Container ...-worker-1    Started
 Container ...-api-1       Started

$ curl -sS -w "\nHTTP %{http_code}\n" http://localhost:8000/healthz
{"status":"ok"}
HTTP 200
```

### A bug this doc found

The migration step above (`docker compose run --rm api uv run alembic
upgrade head`) silently did **not** run migrations before this change —
`apps/api/docker-entrypoint.sh` never referenced `"$@"`, so any command
passed to `docker compose run` was ignored and the container just started
the API server instead. `docker compose up` would then come up "healthy"
per `/healthz` (that endpoint doesn't touch the database) while every
actual request failed against an unmigrated schema. Fixed in this same
change: the entrypoint now execs `"$@"` when a command is passed, falling
through to the normal api/worker startup only when it isn't. Confirmed
fixed by re-running the full sequence above from a clean volume twice.

## 3. Verify it's healthy

```bash
curl http://localhost:8000/healthz          # {"status":"ok"}
docker compose exec api curl http://store:8787/health   # {"ok":true} -- store has no host-published port
```

`GET /mcp` returns a 307 (trailing-slash redirect to `/mcp/`, then 401
without a bearer token) — that's expected, the MCP endpoint is
`http://localhost:8000/mcp` per the root README, auth-gated. `GET /docs`
(FastAPI's Swagger UI) is on by default outside `RAILWAY_ENVIRONMENT_NAME=production`.

## First login

This is the one place self-hosting the compose stack alone doesn't fully
close the loop, and it's worth knowing before you start rather than
discovering it mid-setup.

The `gnt` CLI's API host is fully overridable — `GNT_API_URL` (default
`https://api.gntai.dev`) and `GNT_WEB_URL` (default `https://gntai.dev`) are
read straight from the environment (`apps/cli/src/config.ts`), no config
file or flag needed:

```bash
export GNT_API_URL=http://localhost:8000
```

But `gnt login`'s browser flow opens `${GNT_WEB_URL}/cli-login`, polls
`${GNT_API_URL}/v1/settings/cli-key/poll` until that page writes a key, and
`/cli-login` is an `apps/web` route — the one app this compose stack
deliberately doesn't run. Pointing `GNT_WEB_URL` at nothing means `gnt
login`'s browser step has nowhere to land.

One honest way through this today, not polished, but it works:

**Mint a key by hand.** Open the database shell with
`docker compose exec postgres psql -U gnt -d gnt` (or the equivalent
`docker-compose` command), then insert an `orgs` row and an `mcp_api_keys` row
with a `gnt_live_`-prefixed key whose SHA-256 hash you compute locally. Write
it to `~/.gnt/credentials.json` yourself (`{"api_key": "...", "key_id": "..."}`,
the same shape `saveApiKey()` in `apps/cli/src/credentials.ts` writes).
Manual, and it means trusting yourself with a raw key instead of going
through a real auth flow — acceptable for a local self-host instance you
already control, not something to script into an untrusted-network setup.

Once a key exists in `~/.gnt/credentials.json` (however it got there),
every other CLI command — `gnt status`, `gnt pull`, `gnt review`, `gnt
keys` — works normally against `GNT_API_URL`.

## Connecting a GitHub repo for rules

`gnt connect github` supports two flows: a GitHub App (recommended for the
hosted product — the App is registered once under the `gnt-ai` org, App
ID/client ID are public per `apps/api/.env.example`) or a per-org personal
access token (`gnt connect github --pat`). Self-hosting your own GitHub App
registration is possible (`GITHUB_APP_ID`/`GITHUB_APP_CLIENT_ID`/
`GITHUB_APP_PRIVATE_KEY`/`GITHUB_APP_WEBHOOK_SECRET` in
`apps/api/.env.example`, all optional) but means registering your own App
in GitHub's settings and pointing its webhook at your own `API_ORIGIN` —
the PAT flow is the fast path for a first self-hosted setup. Once a key
exists per "First login" above:

```bash
GNT_API_URL=http://localhost:8000 gnt connect github --pat
```

## Upgrading

```bash
git pull
docker compose build
docker compose run --rm api uv run alembic upgrade head
docker compose up -d
```

Same sequence as the initial boot — `alembic upgrade head` is idempotent
(re-running it against an already-current schema is a no-op, confirmed:
running it twice in a row during this doc's own testing produced no errors
and no duplicate migration output the second time). `apps/store` has its
own separate schema-version tracking (the vendored engine's migration
chain, unrelated to Alembic) — a store-side schema change needs its own
migration step if one's ever introduced; nothing in this compose file
currently runs one, because none exists yet under `STORE_BACKEND=native`.

## Troubleshooting

Failures actually hit while writing this doc, in the order you'd hit them:

- **`ValueError: refusing to start: these settings still have their
  .env.example placeholder value...`** — a `change-me-...` string is still
  sitting in `apps/api/.env`. The error names every offending field;
  generate a real value for each one (see env-vars.md's Fernet-vs-hex
  breakdown) and retry.
- **The migration step exits 0 immediately but the api container later
  500s on every request** — this was the entrypoint bug above; make sure
  you're on a build that includes the `docker-entrypoint.sh` fix (anything
  after this change). If you still hit it: check `docker compose logs api`
  for whether uvicorn actually started during the `run --rm api ... alembic
  upgrade head` step (it shouldn't) versus alembic's own `Running upgrade
  ...` log lines (it should show one line per migration, ending at the
  highest-numbered one in `apps/api/alembic/versions/`).
- **`store` fails to start with `GNT_STORE_INTERNAL_API_SECRET is not
  set`** — `apps/store/.env` wasn't filled in, or `docker compose` didn't
  pick it up (confirm `apps/store/.env` exists at that exact path, not
  `.env.example` still).
- **Every store↔api call gets rejected (401/403) even though both
  services are up** — `STORE_INTERNAL_API_SECRET`/`APPROVAL_SIGNING_SECRET`
  in `apps/api/.env` don't byte-for-byte match
  `GNT_STORE_INTERNAL_API_SECRET`/`GNT_APPROVAL_SIGNING_SECRET` in
  `apps/store/.env`. These fail closed by design, not a bug — regenerate
  both pairs and make sure the two files agree.
- **A rule fails to save with an embedding/rerank error** — `apps/store/.env`
  is missing `ZEROENTROPY_API_KEY`, or it's still empty (see "What's
  actually required" above). Add a real one.

## Local-only mode

There is no local-only / no-cloud-keys mode in this codebase today. Every
LLM call goes through Anthropic (`rule_merge_model`/`check_action_model`,
both Claude Haiku by default) or Groq (voice transcription); every
embedding/rerank call goes through ZeroEntropy. There's no Ollama
integration or equivalent local-inference path — grepped `apps/api/src`
for "ollama" and found nothing. If a fully offline/local-model mode matters
to you, it doesn't exist yet; this is a real gap, not something this doc
is choosing not to cover.

## Self-host vs. hosted — what you're actually choosing between

Self-hosting (this page) gets you the full API, MCP server, worker, and
native store running on your own infrastructure, under your own Anthropic/
Groq/ZeroEntropy/GitHub keys, with the Postgres role split migrations
0013/0014/0035 create (`gnt_app`/`gnt_cron`/`gnt_admin`, row-level
security) as the hardening path before production traffic — set each
role's password by hand right after running migrations for the first
time (they're deliberately never set in the migration files themselves).
You own uptime, upgrades, and support for your own deployment.

The hosted product (gnt.ai) is two flat-rate tiers, per gnt.ai/pricing:
**Base** ($29/mo, 1,500 `check_action` calls/month, 14-day free trial) and
**Pro** ($149/mo, 8,000 calls/month, no trial, the only tier that allows
multi-org membership). Beyond the usage cap difference, the marketing site
doesn't currently spell out specifics like support SLAs or uptime
guarantees. This page and the root README are the accurate statement of
what self-hosting actually supports — if gnt.ai's own marketing copy ever
says otherwise, trust this page.

Either way, your rules live in your own git repo — that part doesn't
change based on who runs the API.

# gnt-api

FastAPI backend for AI GNT.

## Setup

```bash
uv sync
cp .env.example .env # fill in every var
uv run alembic upgrade head
```

apps/store also needs to be running locally — routers/rules.py and the
GitHub webhook handler call it over HTTP for everything past the git-native
rules seam.

## Run

```bash
uv run uvicorn gnt.main:app --reload --port 8000   # API
uv run arq gnt.workers.worker.WorkerSettings        # skill-pack compiler
```

Needs a running Postgres and Redis (`REDIS_URL`/`DATABASE_URL`) — see the repo root for local infra, or point at Railway.

## Scope

- **Git-native rules** (`routers/rules.py`, `github.py`,
  `github_webhook.py`) — rules are drafted via `POST /v1/rules`, proposed
  (`gnt review`), rendered to markdown, and opened as a PR against the
  org's connected GitHub repo. Merging the PR is the approval mechanism;
  the webhook handler picks up the merge, syncs status back through
  apps/store, and recompiles the org's skill pack.
- **Slack** (`routers/slack.py`) — OAuth install flow plus the `/brain`
  slash command, which now just points a workspace at `gnt review`
  (freeform capture-to-knowledge-base was retired, see below).
- **Billing** (`routers/billing.py`) — Stripe checkout/portal sessions
  and webhook handling for the single flat-tier subscription.
- **Skill packs, brain, settings, transcribe** — `routers/skill_packs.py`
  serves compiled pack zips (approved rules only, grouped by tag),
  `routers/brain.py` backs `gnt status`/`gnt connect slack` and onboarding
  metrics, `routers/settings.py` manages MCP API keys,
  `routers/transcribe.py` does server-side voice-input transcription via
  Groq.
- **MCP server** (`mcp_server/`) — mounted at `/mcp`. This is the one
  published, customer-facing, agent-facing MCP surface (a founder decision)
  — `settings.mcp_url` is the source-of-truth URL, echoed
  in the CLI (`gnt keys create`) and the docs site. Four tools, all reading
  from the git-native rules store: `search_rules`, `get_rule`,
  `list_skill_packs`, `get_skill_pack`. apps/store doesn't run an MCP
  server at all anymore — it's purely an internal HTTP service this router
  set talks to (see `apps/store/README.md`).

  A separate, older knowledge-unit pipeline (`capture`, `list_topics`,
  `get_skill`, `search_knowledge`, `ask_brain` — triage/extract/embed via
  Voyage into a Postgres `knowledge_units` table) used to run alongside
  this and was retired: it duplicated retrieval gnt.ai doesn't own to
  build (gnt.ai's product is rules, not a general-purpose RAG store) and
  ran a second paid embedding provider for a deprioritized feature.
  `KnowledgeUnit`/`Conflict`/
  `InterviewQuestion` tables and their migrations are left in place —
  existing rows are untouched, nothing writes new ones.

## Lint

```bash
uv run ruff check src/
```

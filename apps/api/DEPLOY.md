# Deploying to Railway

One Dockerfile, two Railway services: `api` and `worker`. Both build from
the same image; `PROCESS_TYPE` picks which process runs.

## Services

- **api** — leave `PROCESS_TYPE` unset. Runs `uvicorn gnt.main:app` on
  `$PORT`.
- **worker** — set `PROCESS_TYPE=worker`. Runs
  `arq gnt.workers.worker.WorkerSettings` (capture pipeline, skill
  compiler, and the cron jobs — decay_confidence, weekly_gap_digest).

Both services need the full `.env.example` var set filled in (see that
file for what each one does). They talk to the same Postgres and Redis.

## Migrations run automatically

`alembic upgrade head` runs as part of every `api` deploy, via
`railway.json`'s `deploy.preDeployCommand` — Railway runs it inside the
private network, right before the new image starts, using the same
`MIGRATION_DATABASE_URL` the service already has set. It's gated on
`PROCESS_TYPE` so it only actually runs on the `api` service, not
`worker` (both build from this same directory, so Railway may apply the
same config to both — the guard makes the migration a no-op on worker
rather than depending on Railway to scope it per-service). See
`.github/workflows/deploy.yml` for the full pipeline this feeds into.

One Railway-side setting makes this work for the api's native GitHub
deploys: the service's **Config-as-code file path** must be
`apps/api/railway.json`. Railway resolves that path from the repo root,
and with it unset the native deploys read no config at all and silently
skip the migration — learned live when migration 0033 never applied
despite a green deploy (the CLI-era `railway up --path-as-root` deploys
only ever worked because the upload root happened to put railway.json
at `/`).

To run it by hand instead (first-time setup, or a manual out-of-band fix):

```
alembic upgrade head
```

## Database roles (migrations 0013/0014/0035)

Migrations 0013, 0014, and 0035 create the `gnt_app`, `gnt_cron`, and
`gnt_admin` roles but deliberately never set their passwords — a password
baked into a migration file is a password checked into git. Set all three
manually, per environment, right after running migrations for the first
time — connected as a real superuser via `MIGRATION_DATABASE_URL` (not
`gnt_app`, `gnt_cron`, or `gnt_admin` — none of them has the rights to
alter a role):

```sql
ALTER ROLE gnt_app WITH PASSWORD '...';
ALTER ROLE gnt_cron WITH PASSWORD '...';
ALTER ROLE gnt_admin WITH PASSWORD '...';
```

Only then point `DATABASE_URL` at `gnt_app`, `CRON_DATABASE_URL` at
`gnt_cron`, and `ADMIN_DATABASE_URL` at `gnt_admin` for the relevant
service. Do this on every environment (local, staging, prod) separately —
the roles exist from the migration, the passwords don't.

`gnt_admin` backs the internal platform-admin dashboard only (see
migration 0035's own docstring) — it's `SELECT`-only across every table,
plus one column-scoped `UPDATE` on `orgs.plan_tier`/`subscription_status`.
Also set `PLATFORM_ADMIN_EMAILS` (comma-separated) on the `api` service to
whichever emails should actually be able to use it — an empty/unset value
means nobody can, not everybody.

## API_ORIGIN

`API_ORIGIN` has to be the service's real public URL, byte-for-byte
matching what's registered in the Slack app's redirect URI and what
GitHub calls back to for webhooks. You don't know that URL until Railway
assigns the service a domain, so: deploy first, get the domain, set
`API_ORIGIN`, redeploy. Don't guess at it up front.

## STORE_API_URL and shared secrets

`STORE_API_URL` reaches apps/store over Railway's private network —
`<service>.railway.internal:<port>`, not a public domain. Using the
public URL works but adds a hop through the internet for a call that
never needs to leave Railway's network.

`STORE_INTERNAL_API_SECRET` and `APPROVAL_SIGNING_SECRET` here must match
`GNT_STORE_INTERNAL_API_SECRET` and `GNT_APPROVAL_SIGNING_SECRET` in
apps/store's own env exactly — mismatched values fail closed (every call
rejected), not open.

## CI/CD

`.github/workflows/deploy.yml` deploys `api`, `worker`, and `apps/store` to
Railway on every merge to `main`, gated on `.github/workflows/ci.yml`
passing (it triggers on that workflow's completion, not on push directly,
so a red CI run never reaches production). Requires four repo secrets:

- `RAILWAY_TOKEN` — a Railway **project token** (Project Settings → Tokens
  in the dashboard), not an account token. Scoped to just this project, so
  a leaked token can't touch anything outside it.
- `RAILWAY_PROJECT_ID` — your project's id (Project Settings → General in
  the Railway dashboard). Passed explicitly since the GitHub Actions
  runner has no locally-linked Railway project the way a dev machine does.
- `BRUNO_SMOKE_CLI_KEY` / `BRUNO_SMOKE_MCP_KEY` — a cli-type (`is_admin=true`)
  and an mcp-type API key for a dedicated test org, used only by the
  post-deploy `bru run` smoke step (see `bruno/README.md`) to confirm the
  live deploy actually answers correctly, not just that it built. Read-only
  requests only; revoking and re-minting either key is safe at any time.

Manual redeploy (skips the CI gate, e.g. to re-run a flaky deploy step):
`gh workflow run deploy.yml`, or `railway redeploy --service <name>` for a
single service.

## Rollback

Railway keeps every deployment; rolling back means re-activating an older
one, not reverting git and re-deploying (slower, and re-triggers CI).

1. Find the last good deployment:
   `railway deployment list --service <api|worker|store> --json` — look
   for the last one with `status: "SUCCESS"` before the bad one.
2. Roll back via the dashboard: the service's **Deployments** tab → the
   good deployment's `...` menu → **Redeploy**. There's no CLI equivalent
   as of this Railway CLI version (`railway redeploy` only re-runs the
   *latest* deployment, not an arbitrary older one).
3. If the bad deploy included a migration (api's `preDeployCommand`),
   rolling back the *code* does not undo the *schema* — Alembic migrations
   aren't auto-reversed. Check whether the migration was additive (safe to
   leave in place while old code runs) or breaking (needs a manual
   `alembic downgrade` via `railway ssh -s api -- uv run alembic downgrade
   -1`) before assuming a code rollback alone fixes things.
4. `store` has its own separate schema-version tracking (the vendored
   engine's own migration chain, unrelated to Alembic) — same caveat
   applies if a store deploy introduced a schema change.

## P0 acceptance test (scripts/acceptance_e2e.py)

Runs the full connect → propose → real PR → real merge → webhook-approval
→ real MCP client query loop against production, plus a real (unmocked)
check that the GitHub App's JWT-signing/auth plumbing works against
production. See the script's own docstring for the full explanation and
why the connect step still uses the legacy PAT flow, not the App install
flow (GitHub App installs need a human in a browser — not scriptable);
the short version:

**Getting `E2E_ADMIN_KEY`.** There's no scripted way to mint an
`is_admin=true` key — `create_cli_key` requires a live session by
design (closes a self-escalation path where an API key mints a more
capable one). For a throwaway test org, insert the row directly instead:

```sql
INSERT INTO orgs (id, trial_ends_at) VALUES ('<org_id>', now() + interval '14 days')
  ON CONFLICT (id) DO UPDATE SET trial_ends_at = now() + interval '14 days';
INSERT INTO mcp_api_keys (id, org_id, key_hash, name, is_admin)
  VALUES ('<uuid4>', '<org_id>', '<sha256 hex of the plaintext key>', 'e2e-acceptance-admin', true);
```

The plaintext key must start with `gnt_live_` (see `auth/mcp_keys.py`'s
`generate_key()`) — only the SHA-256 hash is ever stored, so compute both
locally and only insert the hash.

**Getting `E2E_GITHUB_PAT`.** A fine-grained PAT (GitHub → Settings →
Developer settings → Fine-grained tokens), scoped to *only*
`E2E_TEST_REPO`, with Contents/Pull requests/Webhooks set to Read and
write. Never reuse a broadly-scoped personal token — it would give the
GithubConnection row (and anything reading it) access to every repo you
own, not just the test one.

Run it: `E2E_BASE_URL=... E2E_ADMIN_KEY=... E2E_GITHUB_PAT=... E2E_TEST_REPO=owner/repo uv run python scripts/acceptance_e2e.py`

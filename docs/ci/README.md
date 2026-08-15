# CI/CD

What runs where, what's cached, how to add a job without breaking the existing conventions, and
what to do when a check fails. Read straight out of `.github/workflows/*.yml` at the time this
was written — if it drifts, trust the workflow files and fix this doc.

## What runs on every PR and every push to main

Two workflows fire on every `pull_request` and every push to `main`: `ci.yml` and `security.yml`.
Both also support `workflow_dispatch` for a manual run.

**`ci.yml`**

- `js`: lint, typecheck, build, and test for the pnpm workspace (`apps/cli`, `apps/docs`, and
  `examples`). Each task type has its own `pnpm turbo run` step so a stall names the exact
  check. Every step runs across all three workspaces, including on workflow-only changes.
  Required status check: `js (lint, typecheck, build, test)`.
- `clean-install` — proves a fresh `git clone` with no `.env` and no repo secrets can install and
  typecheck the JS/TS workspace and `apps/api`, matching `CONTRIBUTING.md`'s own quickstart.
  `continue-on-error: true` — not a required check, it's a canary for "did we accidentally start
  depending on a secret or a stale cache to even install."
- `store` — lint, typecheck, test for `apps/store` (Bun-native, its own lockfile, outside the
  pnpm workspace on purpose — see `pnpm-workspace.yaml`). Required status check:
  `store (lint, typecheck, test)`.
- `api` — ruff + pytest for `apps/api`. Required status check: `api (ruff, pytest)`.
- `alembic-migration-changes` / `alembic-check` — a cheap gate job that diffs the PR against its
  base branch for changes under `apps/api/migrations/versions/` or `alembic.ini`, and only then
  runs the expensive job: spin up a throwaway Postgres and run `alembic upgrade head` against it.
  Neither is a required status check today, but a red `alembic-check` on a PR that touches
  migrations means the migration doesn't apply cleanly — fix it before merging regardless.

**`security.yml`**

- `api-audit` — `uv audit --frozen` against `apps/api`'s lockfile.
- `js-audit` — `pnpm audit` for the pnpm workspace, `bun audit` for `apps/store`.
- `gitleaks` — scans full git history (not just the PR diff) for secrets, plus a narrow grep of
  `bruno/` for gnt's own credential shapes (API keys, webhook tokens, Stripe secrets, Fernet
  keys) that must only ever appear as `{{var}}` interpolation, never literal strings.
- `public-copy-scrub` — greps the actual public-facing surfaces (marketing site, public docs, the
  npm-published CLI's README/source/starter-packs) for banned third-party automation-tool names.
- `workflow-security` — runs `.github/scripts/check_workflow_security.py`, a static check that no
  workflow uses `pull_request_target` and that no fork-reachable job can land on a bare
  `self-hosted` runner or trust a fork's `workflow_run` payload.

Required status checks out of this workflow: `api-audit (uv audit)`, `js-audit (pnpm audit, bun
audit)`, `gitleaks`. `public-copy-scrub` and `workflow-security` are not required checks today,
but treat a red one the same way — it's telling you something real.

## What only runs on paths-filtered changes

Two workflows are their own files (not jobs inside `ci.yml`) specifically because GitHub Actions
path filtering is workflow-level, not job-level:

- **`self-host-compose.yml`** — only runs when `docker-compose.yml`, `apps/api/Dockerfile`,
  `apps/api/docker-entrypoint.sh`, `apps/store/Dockerfile`, `docs/self-hosting/**`, or the
  workflow file itself changes. It builds the real images, runs the real one-time
  `alembic upgrade head` migration step, brings the compose stack up with throwaway secrets
  generated fresh in the job (`openssl rand`, never a repo secret), and polls `/healthz`. Runs
  unconditionally on `ubuntu-latest`, including fork PRs — it never touches the self-hosted
  runner and needs no real credentials, so there's nothing here for a fork-safety guard to guard.
- **`extraction-eval.yml`** — only runs when `apps/cli/src/prebrain/extraction/**` or
  `apps/cli/eval/extraction/**` changes. Measures precision/recall for the prebrain extraction
  step against a seeded corpus using real, paid Anthropic API calls
  (`claude-haiku-4-5`), which is exactly why it doesn't run on every push like `ci.yml` does. If
  `ANTHROPIC_API_KEY` isn't set as a repo secret (true as of this writing — see the workflow's own
  comment), the job skips with a loud `::warning::` instead of failing.

If your PR doesn't touch the paths above, you won't see these workflows run at all — that's
expected, not a bug.

## What only runs on push to main

- **`deploy.yml`** — triggered by `workflow_run` after `ci.yml` completes successfully on `main`
  (not a plain `push` trigger, so it genuinely waits on CI rather than racing it), plus
  `workflow_dispatch`. Deploys `apps/store` via the Railway CLI (the only service without its own
  native Railway git integration), verifies `apps/api`'s `/healthz` comes up, and — only if the
  `BRUNO_SMOKE_CLI_KEY`/`BRUNO_SMOKE_MCP_KEY` repo secrets are set — runs a read-only Bruno smoke
  suite against production. Runs on the self-hosted macOS runner.
- **`publish-cli.yml`** — triggered by a push to `main` that changes `apps/cli/package.json`, plus
  `workflow_dispatch`. Publishes `@gnt-ai/cli` to npm via npm's OIDC trusted-publisher flow (no
  `NPM_TOKEN`), skips if that exact version is already published, and tags a release on the
  public `gnt-ai/gnt` repo using a separate fine-grained PAT (`GH_RELEASE_TOKEN`) since the
  default `GITHUB_TOKEN` can't write outside this repo.

## Caching

- **pnpm store** — every job that runs `pnpm install` uses `actions/setup-node`'s built-in
  `cache: pnpm` option, keyed off `pnpm-lock.yaml`. This is wired up in `ci.yml` (`js`,
  `clean-install`), `security.yml` (`js-audit`), and `extraction-eval.yml`.
- **uv cache** — every job that runs `uv sync`/`uv audit` uses `astral-sh/setup-uv`'s
  `enable-cache: true`. Wired up in `ci.yml` (`clean-install`, `api`, `alembic-check`) and
  `security.yml` (`api-audit`).
- **No Turbo remote cache in this repo.** Fork PRs never receive secrets, and remote caching
  needs a token, so this repo runs every turbo invocation cold. The `js` job checks all three
  workspaces on purpose so changes to the workflow itself cannot pass with zero tasks.
- No caching is wired up for `apps/store`'s `bun install` — `oven-sh/setup-bun` doesn't cache by
  default and none of the `store`/`api`/`extraction-eval` jobs opt into one.

## Adding a new job

Copy an existing job in `ci.yml` or `security.yml` as your starting point, and keep these
conventions — a new job that skips any of them is a diff a reviewer should bounce:

1. **SHA-pin every third-party action, with a version comment.** `uses: owner/repo@<full sha>
   # vX.Y.Z`. Every action in this repo's workflows is pinned this way (see any `actions/checkout`
   or `pnpm/action-setup` line) — never a bare tag or branch ref, a compromised tag can silently
   swap out what code runs in CI.
2. **Add a `permissions:` block.** The repo default across every workflow here is
   `contents: read` at the workflow level, least-privilege by default. Only widen it on the
   specific job that needs more (see `publish-cli.yml`'s `publish` job, which adds
   `id-token: write` for npm's OIDC exchange), never at the workflow level.
3. **Add a `concurrency:` group.** Every workflow in this repo has one, scoped so a new push
   cancels the previous in-flight run for the same ref (`cancel-in-progress: true`) except
   `deploy.yml` and `publish-cli.yml`, which set `cancel-in-progress: false` because a
   mid-deploy or mid-publish cancellation is worse than letting it finish. Match whichever
   behavior fits your job.
4. **Add a `timeout-minutes:`.** Every job in this repo has one — GitHub's 360-minute default is
   not a real backstop, it just means a wedged step sits there for six hours blocking whatever
   queues behind it. Pick something generous relative to what the job normally takes, not the
   default.
5. **If your job needs a database (or any other service), start it by hand with `docker run`,
   don't use GitHub Actions' `services:` block.** Every job here that needs Postgres or Redis
   (`store`, `api`, `alembic-check`) starts its own throwaway container in a `docker run -d`
   step, waits for it with a `pg_isready`/`redis-cli ping` poll loop, and tears it down in an
   `if: always()` step at the end. Running concurrently-safe jobs this way needs a run-scoped
   container name and a random host port (see `store`'s own comment in `ci.yml` for the exact bug
   this caught — two jobs colliding on a shared fixed port and silently sharing one database
   mid-test).

## Troubleshooting

**A required check is failing on my PR.** Check `main`'s branch protection settings (Settings →
Branches) for the current required-check list. Any of those red means the PR can't merge until
it's green — not just a warning. Everything else in `ci.yml`/`security.yml` that isn't in that
list still runs but isn't a merge blocker; still worth fixing.

**Where to look at logs.** `gh run list --branch <your-branch>` to find the run, then
`gh run view <run-id> --log-failed` for just the failing step's output (or `gh run view <run-id>
--log` for everything). The GitHub PR page's checks tab links straight to the same run if you'd
rather read it in the browser.

**A workflow I expected to run didn't run at all.** Check whether it's one of the paths-filtered
ones (`self-host-compose.yml`, `extraction-eval.yml`) — if your diff doesn't touch the paths
listed above, it's correctly not running, not broken.

**`extraction-eval` shows a skip warning instead of running.** Expected until
`ANTHROPIC_API_KEY` is added as a repo secret — see that workflow's own comment. It doesn't fail
the build.

**Re-running a failed run.** `gh run rerun <run-id>` reruns everything; `gh run rerun <run-id>
--failed` reruns only the jobs that failed. Useful for a flaky Docker container start, not for a
real code failure — re-running a genuine lint/type/test failure just gets you the same red run.

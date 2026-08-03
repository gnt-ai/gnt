# Contributing to gnt

## Dev setup

```bash
git clone https://github.com/gnt-ai/gnt
cd gnt
pnpm install
```

That covers `apps/cli` and `apps/docs` (the pnpm workspace). Two apps need their own setup on
top of that:

```bash
cd apps/api && uv sync && cp .env.example .env    # fill it in, needs local Postgres + Redis
cd apps/store && bun install && cp .env.example .env
```

`apps/api` and `apps/store` talk to each other over HTTP in local dev. `apps/store`'s server
has to be running for `apps/api`'s rules routes to work. See each app's own README for the
full run instructions, and the root README's self-host section for a docker-compose path that
brings up all of it plus Postgres and Redis in one shot.

## Test and lint

```bash
pnpm turbo run lint typecheck build test   # web + cli, via turbo
```

```bash
cd apps/api && uv run ruff check . && uv run pytest
cd apps/store && bun run lint && bun run typecheck && bun test
```

Run whichever of these covers the app(s) your change touches before opening a PR.

## Code conventions

Match what's already there. This codebase writes clean, minimal code and leans on comments to
explain *why* a decision was made, not to narrate what the code obviously does. New code and
new PRs should read the same way. No dead code, no speculative abstractions for a single call
site, no new dependency when a few lines does the job.

## What a good PR looks like

**One logical change per PR.** If your diff does two unrelated things, split it into two PRs,
even if they touch the same file. A PR that fixes a bug and also refactors the function around
it is two PRs. This isn't bureaucracy: a scoped PR is fast to review and safe to revert on its
own; a bundled one makes both changes hostage to whichever part is slower to land.

**User-facing changes get a changelog entry.** If your PR changes something a customer or
contributor would notice (CLI behavior, API responses, docs that ship with a release), add a
short bullet under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md) in the same PR. Don't
invent detail for pre-changelog versions — just keep the Unreleased section current going
forward.

**Show it actually works, not just that it compiles.** State how a reviewer can confirm your
change does what you say, in the PR description:

- **Bug fix:** the test that failed before your fix and passes after it, or a command
  transcript showing the broken behavior and the fixed behavior side by side (a `bru run`
  output, a `gnt` CLI session, a `curl` against a local `apps/api`). "I fixed it" isn't
  evidence; "here's the request that used to 500 and now returns 200" is.
- **New feature or connector:** the new test(s) you added, plus a real command sequence a
  reviewer can run themselves to see it work, not just a description of what it should do.
- If there's genuinely no way to demonstrate it (a pure doc fix, a comment correction), say so
  instead of leaving the section blank.

This is the same standard the codebase already holds itself to: every fix this project ships
gets verified against a real run, not just read back. Your PR gets the same bar.

## What CI runs on your PR

`.github/workflows/ci.yml` runs lint/typecheck/build/test for `apps/cli` and `apps/docs`, plus
`apps/store` and ruff + pytest for `apps/api`, on every push and PR. `.github/workflows/security.yml`
runs dependency audits and a secret scan.

Two things are deliberately different for PRs from a fork:

- **Every job runs on a throwaway hosted runner, not the self-hosted box.** Same-repo PRs and
  pushes to `main` run on our own machine. A fork PR gets an identical job (same lint/typecheck/
  build/test steps, same pass/fail signal) on GitHub's own runner instead, so a fork PR never
  gets to execute code on hardware we control. `.github/scripts/check_workflow_security.py`
  fails CI if this guard is ever missing from a job a fork PR can reach.
- **`.github/workflows/extraction-eval.yml` (a separate workflow, only triggered by changes
  under `apps/cli/src/prebrain/extraction/`) skips its live model-quality gate on a fork PR**,
  since GitHub never forwards repo secrets like `ANTHROPIC_API_KEY` to a fork's `pull_request`
  run. It prints a warning and exits clean rather than failing. That eval measures extraction
  quality against a real model, and there's no free deterministic substitute the way the
  retrieval eval has (that one precomputes and replays fixture embeddings, so it never needs a
  live call in CI at all; see `apps/api/eval/rule_retrieval/README.md`). If your PR touches
  extraction, run `bun run eval:extraction -- --mode cloud` locally with your own key and paste
  the recall/precision numbers into your PR description.

## Sign off your commits (DCO)

Every commit needs a `Signed-off-by` trailer:

```bash
git commit -s -m "your message"
```

That adds a line like `Signed-off-by: Your Name <you@example.com>` to the commit, which is you
certifying you wrote the change (or otherwise have the right to submit it) under the
[Developer Certificate of Origin](https://developercertificate.org/), the same mechanism the
Linux kernel and a lot of other open-source projects use instead of a CLA. It's a statement,
not paperwork: no separate form, no signing tool, just the flag on `git commit`.

There's no automated DCO check wired into CI yet. That's a real gap, tracked as follow-up, not
something this PR (or any PR) should assume is enforced. Sign off anyway; it'll get checked by
a maintainer by hand until the bot exists.

## Opening a PR

Use the PR template. If you're adding a new connector, see the "connector request" issue
template first: there's a real framework for this (`apps/cli/src/prebrain/`'s walkers,
`apps/api`'s per-connector OAuth/token routers), and a maintainer can point you at the shortest
path through it before you write a lot of code that doesn't fit the shape.
[`docs/contributing/adding-a-connector.md`](docs/contributing/adding-a-connector.md) is that
shortest path written down: a real worked example (two actual connectors, top to bottom)
instead of a maintainer explaining it to you from scratch.

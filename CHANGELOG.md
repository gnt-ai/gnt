# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is the source of truth for release notes going forward. Entries for
versions published before the public repo existed are best-effort placeholders —
those releases predate recorded changelog history. Only versions that actually
exist on npm are listed (`npm view @gnt-ai/cli versions`); there was no `0.2.0`
or `0.5.5` publish.

## [Unreleased]

### Added

- `gnt doctor` checks the local Node version, login credentials, API
  reachability, GitHub rules-repo connection, and common self-host `.env`
  mistakes in one pass.
- Documentation for the `gnt org`, `gnt billing`, and `gnt stale` CLI
  commands, including current behavior, examples, and follow-up actions.
- `./demo.sh` provides a Docker-only, seeded `check_action` evaluation path
  with an isolated Compose project and a ready-to-copy curl request.
- Runnable LangChain, Vercel AI SDK, and Anthropic tool-use examples that call `check_action`
  before a simulated refund and fail closed on blocked or human-review verdicts.
- `gnt status` and `gnt gaps` now accept a `--json` flag that prints the
  same data as machine-readable JSON instead of the human-formatted output,
  for scripting a CI gate or dashboard around either command.
- README now has a Contributors section so merged PRs show up somewhere
  beyond the commit graph.
- `gnt completion bash|zsh|fish` prints a shell completion script, generated
  from the CLI's own command table.
- New starter pack: `account-offboarding`, covering identity verification
  before deletion, legal-hold and unresolved-billing overrides on retention,
  closure approval beyond the requesting agent, a grace period before
  permanent deletion, and confirmation back to the requester.
- `gnt rules lint [path]` validates a rule file's frontmatter shape locally
  (title/body length, `status`, `confidence`, `owner_id`, `tags`) — the same
  constraints `apps/api` enforces server-side — so a malformed rule fails
  before a PR round-trip instead of after. Defaults to `./rules`.
- `gnt init` scaffolds a local `rules/` directory with a couple of example
  rule files, for a brand-new repo with nothing yet for `gnt prebrain` to
  scan. Prints the available starter packs as the next step.
- New starter pack: `marketing-brand-approval`, covering sign-off on
  performance/results claims, legal review for competitor mentions,
  approval on pricing-page changes, following a brand style guide, and
  documented permission before using customer quotes or logos.
- New starter pack: `customer-success-renewals`, covering renewal-risk
  escalation timing, win-back discount approval, usage-drop churn signals,
  save-play review before a CSM commits to an offer, and logging contract
  downgrades as a partial churn signal.
- New starter pack: `soc2-audit-readiness`, covering evidence-collection
  cadence, control-owner assignment, compensating-control notes for changes
  during an active audit window, audit scope review, and evidence-gap
  remediation.
- New starter pack: `content-moderation-brand-safety`, covering unverified
  claims, competitor disparagement, off-brand tone, legal-sensitive topics,
  and silent edits/deletions on public or customer-facing posts.
- New starter pack: `open-source-license-compliance`, covering license checks
  on new dependencies, copyleft escalation, unlicensed code, third-party
  attribution and notices, and centralized license tracking.
- New starter pack: `ai-agent-governance`, covering `needs_human` escalation,
  never bypassing `check_action`, smoke-testing new agent integrations,
  audit logging of the verdict that allowed an action, and rule changes not
  applying retroactively to actions already in flight.
- Docs: a new "gnt vs. OPA/Cedar vs. a system prompt" page, covering where each fits
  and where OPA/Cedar are still the better call.
- `gnt-ai/gnt/.github/actions/lint-rules`, a composite GitHub Action that runs
  `gnt rules lint` in CI, for a rules repo to drop into its own PR checks
  without installing the CLI ahead of time.

### Fixed

- `docs/self-hosting/gen_env_vars.py` now reads and writes `config.py`/
  `env-vars.md` with explicit UTF-8, instead of the platform default (cp1252
  on Windows, which was silently mangling a trailing "…" in one setting's
  note). Regenerated `env-vars.md`, which also picks up the trial-risk and
  GitLab OAuth settings that had been added to `config.py` since the last
  regen.
- `gnt billing` no longer crashes with a raw stack trace if the API is
  unreachable — a network failure on either request now prints the same
  `fail()`-styled message as `gnt gaps` and `gnt stale`.

## [0.6.0] - 2026-07-27

### Added

- Public tracking for `@gnt-ai/cli` starts here. The package was already at
  `0.6.0` on npm before `gnt-ai/gnt` went public; the repo history begins with a
  single squashed commit from the Apache-2.0 relicense/public cut, so there is
  no real incremental history to generate notes from for this release.
- From here on, every real `@gnt-ai/cli` version bump is auto-tagged and
  auto-noted when it publishes to npm, and public-repo-only activity in between
  gets a weekly batch release (see `batch-release.yml`).

## [0.5.7] - 2026-07-21

Pre-changelog release — see npm/git history.

## [0.5.6] - 2026-07-21

Pre-changelog release — see npm/git history.

## [0.5.4] - 2026-07-21

Pre-changelog release — see npm/git history.

## [0.5.3] - 2026-07-20

Pre-changelog release — see npm/git history.

## [0.5.2] - 2026-07-20

Pre-changelog release — see npm/git history.

## [0.5.1] - 2026-07-20

Pre-changelog release — see npm/git history.

## [0.5.0] - 2026-07-18

Pre-changelog release — see npm/git history.

## [0.4.1] - 2026-07-16

Pre-changelog release — see npm/git history.

## [0.4.0] - 2026-07-15

Pre-changelog release — see npm/git history.

## [0.3.0] - 2026-07-15

Pre-changelog release — see npm/git history.

## [0.1.0] - 2026-07-15

Pre-changelog release — see npm/git history.

[Unreleased]: https://github.com/gnt-ai/gnt/compare/cli-v0.6.0...HEAD
[0.6.0]: https://github.com/gnt-ai/gnt/releases/tag/cli-v0.6.0
[0.5.7]: https://www.npmjs.com/package/@gnt-ai/cli/v/0.5.7
[0.5.6]: https://www.npmjs.com/package/@gnt-ai/cli/v/0.5.6
[0.5.4]: https://www.npmjs.com/package/@gnt-ai/cli/v/0.5.4
[0.5.3]: https://www.npmjs.com/package/@gnt-ai/cli/v/0.5.3
[0.5.2]: https://www.npmjs.com/package/@gnt-ai/cli/v/0.5.2
[0.5.1]: https://www.npmjs.com/package/@gnt-ai/cli/v/0.5.1
[0.5.0]: https://www.npmjs.com/package/@gnt-ai/cli/v/0.5.0
[0.4.1]: https://www.npmjs.com/package/@gnt-ai/cli/v/0.4.1
[0.4.0]: https://www.npmjs.com/package/@gnt-ai/cli/v/0.4.0
[0.3.0]: https://www.npmjs.com/package/@gnt-ai/cli/v/0.3.0
[0.1.0]: https://www.npmjs.com/package/@gnt-ai/cli/v/0.1.0

<div align="center">

<a href="https://gntai.dev">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/brand/wordmark-dark-bg.svg">
  <img src=".github/brand/wordmark.svg" alt="gnt" width="220">
</picture>
</a>

[![License](https://shieldcn.dev/github/license/gnt-ai/gnt.svg?variant=secondary)](LICENSE) [![npm](https://shieldcn.dev/npm/@gnt-ai/cli.svg?variant=secondary)](https://www.npmjs.com/package/@gnt-ai/cli) [![Release](https://shieldcn.dev/github/release/gnt-ai/gnt.svg?variant=secondary)](https://github.com/gnt-ai/gnt/releases/latest)

</div>

Run the setup below once and every agent your team runs has a **git-native rulebook** it has to check over **MCP** before it acts, approved the same way your code already is: a **merged pull request**.

- Rules live in your repo as files and ship through normal PRs, not a dashboard click.
- Agents call `check_action` over MCP before anything risky (a refund, a delete, a message to a customer) and get back an allow/block/escalate verdict.
- Every rule traces back to the git file and the PR that approved it, so "why did the agent do that" always has a paper trail.

> Prefer not to run any of this yourself? The hosted version at [gntai.dev](https://gntai.dev) does the same thing without you standing up a Postgres instance.

![A real terminal session of gnt prebrain scanning a repo, opening a PR, and getting merged](.github/assets/quickstart.png)

*gnt prebrain scanning a repo, opening a PR, and getting it merged. A real terminal session, not a mockup.*

## Get started (30 seconds)

```bash
npm install -g @gnt-ai/cli
gnt login
gnt connect github
gnt prebrain
# merge the opened PR on GitHub. that merge is the approval
```

![gnt connect's interactive picker, and what gnt prebrain's draft-PR output looks like](.github/assets/cli-demo.gif)

*The `gnt connect` picker — j/k to navigate, shows what's already connected, disconnect right
from the CLI. (The `gnt prebrain` output shown is illustrative, not a captured run.)*

That merge lands a rule file in your connected repo, shaped like this:

```
your-repo/
└── rules/
    ├── refund-approval-threshold.md
    └── contract-legal-cc.md
```

Each file is plain markdown with YAML frontmatter:

```markdown
---
title: Never refund over $500 without a manager
status: approved
confidence: 0.91
owner_id: finance-team
source_citations: [...]
source: slack
tags: [refunds, finance]
last_validated_at: 2026-07-20
version: 1
superseded_by: null
approved_by: jane@company.com
approved_at: 2026-07-21T14:03:00Z
created_at: 2026-07-18T09:12:00Z
pr_number: 142
pr_url: https://github.com/your-org/your-repo/pull/142
---

Refunds over $500 need manager sign-off before they go out...
```

## See it in action

There's no captured transcript to show yet (see the gap noted at the bottom of this README).
Here's the actual response shape a `check_action` call returns, straight from the tool's
contract:

```json
{
  "verdict": "blocked",
  "reason": "Refund exceeds the $500 threshold without manager sign-off (rules/refund-approval-threshold.md)",
  "cited_rules": [
    { "id": "refund-approval-threshold", "title": "Never refund over $500 without a manager" }
  ],
  "rules_retrieved": 3
}
```

`verdict` is one of `allowed`, `blocked`, or `needs_human`. `needs_human` is the fail-closed
default: no approved rule covers the action, retrieval failed, or the check couldn't complete.
It never guesses.

## What it does

One MCP endpoint, five tools:

| Tool | What it does |
| --- | --- |
| `check_action` | Checks a described action against your approved rules before an agent takes it. Returns `allowed`, `blocked`, or `needs_human` with cited rules and a one-line reason. |
| `search_rules` | Semantic search over your org's approved rules, optionally filtered by tag. An empty list means no approved rule covers the query. |
| `get_rule` | Fetches one approved rule by id, with its provenance (who approved it, when, what it was cited from). |
| `list_skill_packs` | Lists every compiled skill pack version for your org, newest first. |
| `get_skill_pack` | Fetches a compiled skill pack's manifest and file list by id. |

## Prerequisites

| Requirement | Check | Get it |
| --- | --- | --- |
| Node >=22.13 | `node --version` | [nodejs.org](https://nodejs.org) |

## Install

| Method | Command |
| --- | --- |
| curl | `curl -fsSL gntai.dev/install.sh \| sh` |
| npm | `npm install -g @gnt-ai/cli` |

> gnt needs Node >=22.13. If the CLI fails to start with a version error, update Node first and confirm with `node --version`.

## Common commands

```bash
gnt login                # sign in, store an API key locally
gnt connect github       # connect the repo your rules PRs open against
gnt prebrain             # scan sources, extract candidate rules, open PRs
gnt review               # review rules awaiting approval
gnt status               # show brain status
gnt pull                 # download the latest skill pack
gnt gaps                 # list uncovered queries with no approved rule
```

## Config

| Variable | Default | What it controls |
| --- | --- | --- |
| `GNT_API_URL` | `https://api.gntai.dev` | API endpoint the CLI and MCP calls hit |
| `GNT_WEB_URL` | `https://gntai.dev` | Web app used for `gnt login`'s browser step |
| `GNT_CONFIG_DIR` | `~/.gnt` | Where `credentials.json` and local config live |

## Privacy

- No analytics or telemetry dependency in the CLI or the web app.
- `gnt prebrain`'s default extraction mode is cloud, not on-device: your source text goes straight to Anthropic's API (or Vercel AI Gateway with zero-data-retention, if you configure it), never to gnt's own servers. Fully on-device extraction needs `--mode local` against a local Ollama daemon.
- The extracted rule candidates still get sent to gnt's API to open the PR. Raw source text stays off gnt's servers in cloud mode; the resulting rule text doesn't.
- Rules live in your connected GitHub repo and in gnt's own database. The MCP tools read from gnt's store, not by cloning your repo on every call.
- Self-hosting: `apps/api` only sends error data to Sentry if you set `SENTRY_DSN` yourself. Leave it unset and nothing goes out.

## Team setup

- **Who writes rules**: anyone with access to your connected repo, either through `gnt prebrain` (batch-extracted from real sources) or `gnt review` (hand-proposed).
- **How approval works**: merging the PR is the approval. There's no separate publish step.
- **What gets committed**: `rules/<rule-id>.md` files with the frontmatter shown above and a plain markdown body.

## Troubleshooting

> **Self-hosting: `gnt login`'s browser step has nowhere to land.** `gnt login` opens a browser to a `/cli-login` page and polls the API for the resulting key — that page is served by the hosted product's web app, which isn't part of this repo. There's no CLI-only login flow (device code or otherwise) today, and no `gnt` command to set a key manually. Self-hosting this stack currently means building your own thin frontend for that one route (it just needs to complete the sign-in flow and hand the CLI a key). This is a real, open gap in the self-host path, not a config issue — closing it properly means adding a CLI-only login flow.

> **`ValueError: refusing to start: these settings still have their .env.example placeholder value...`** A `change-me-...` string is still sitting in `apps/api/.env`. The error names every offending field; generate a real value for each and retry.

> **`store` fails to start with `GNT_STORE_INTERNAL_API_SECRET is not set`.** `apps/store/.env` wasn't filled in, or wasn't picked up. Confirm the file exists at that exact path, not still named `.env.example`.

> **Every store-to-api call gets rejected with 401 or 403, even though both services are up.** `STORE_INTERNAL_API_SECRET` / `APPROVAL_SIGNING_SECRET` in `apps/api/.env` don't byte-for-byte match `GNT_STORE_INTERNAL_API_SECRET` / `GNT_APPROVAL_SIGNING_SECRET` in `apps/store/.env`. This fails closed by design. Regenerate both pairs so the two files agree.

> **A rule fails to save with an embedding or rerank error.** `apps/store/.env` is missing `ZEROENTROPY_API_KEY`, or it's still empty. Get a real one from zeroentropy.dev.

## Full command reference

```
gnt login
gnt logout
gnt connect <app>        github, slack, notion-mcp, monday-mcp, linear-mcp, jira-mcp,
                          sentry-mcp, granola-mcp, zoom-mcp, figma, datadog,
                          gitlab-threads, hubspot, airtable, openclaw, hermes
gnt disconnect <app>
gnt status
gnt billing
gnt review
gnt pull
gnt gaps
gnt prebrain              scan local sources, extract candidate rules, open batched draft
                           PRs (~60 flags for source paths and extraction mode, see
                           `gnt prebrain --help`; --mode cloud|local, cloud is the default)
gnt stale
gnt keys list|create|revoke|rotate
gnt webhook list|create|revoke
gnt org show|rename|invite|remove
```

## Learn more

- Self-hosting walkthrough, including the production-hardening path: [`docs/self-hosting/README.md`](docs/self-hosting/README.md)
- Security policy: [`SECURITY.md`](SECURITY.md)

## License

Copyright © 2026 gnt.ai. Licensed under Apache-2.0 — see [`LICENSE`](LICENSE) for the terms and [`NOTICE`](NOTICE) for the trademark rule on forks.

### Why is this free?

Self-hosting gnt costs you nothing, forever — clone it, run `docker compose up`, bring your own keys. What we sell is the part self-hosting doesn't give you: hosting at [gntai.dev](https://gntai.dev), managed OAuth connectors (GitHub, Slack, Linear, Notion, Zendesk — no app-approval process on your end), and usage-based AI features. If you'd rather run it yourself, that's a fully supported, fully free path, not a crippled trial of the real thing.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for dev setup and how to open a PR. Every commit needs a `Signed-off-by` trailer (`git commit -s`), the [Developer Certificate of Origin](https://developercertificate.org/) instead of a CLA. No separate form, just the flag.

<div align="center">

[![Discussions](https://shieldcn.dev/badge/discussions-github.svg?variant=secondary)](https://github.com/gnt-ai/gnt/discussions) [![Issues](https://shieldcn.dev/github/issues/gnt-ai/gnt.svg?variant=secondary)](https://github.com/gnt-ai/gnt/issues) [![Code of conduct](https://shieldcn.dev/badge/code%20of%20conduct-CODE_OF_CONDUCT.md.svg?variant=secondary)](CODE_OF_CONDUCT.md)

</div>

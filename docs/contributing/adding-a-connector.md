# Adding a connector

This is the "shortest path through the existing pattern" CONTRIBUTING.md and the connector
request issue template both point at. It's a real walkthrough of two connectors that are already
in the codebase, not a spec for an abstraction that doesn't exist yet — every path, class, and
route name below is real, read straight out of the source at the time this was written. If it
drifts from what's actually there, trust the code and file a PR fixing this doc.

## Read this part first: there are three shapes, not one

Before you copy a pattern, figure out which of gnt's connectors your new one actually resembles.
They are not interchangeable, and picking the wrong one to copy will cost you a rewrite.

**Shape 1 — OAuth connect, CLI-side content walker.** Notion and Linear. The web dashboard runs a
real OAuth flow and stores an encrypted access token server-side. The CLI later fetches that same
token over an authenticated `GET /v1/<connector>/token` call, then does all the actual
read/parse/chunk work locally, on the contributor's or customer's own device, through the shared
`apps/cli/src/prebrain/mcp-framework/` runner. Connecting does not pull anything by itself — a
human still has to run `gnt prebrain --mcp-notion` (or `--mcp-linear`) for content to move.
This is the shape most new "pull prose from a SaaS tool and propose rules from it" connectors
should copy. **Worked example below.**

**Shape 2 — token connect, server-side nightly sync.** Zendesk and Intercom. No OAuth: a customer
pastes a self-serve API token straight into a `POST /v1/settings/<connector>` call, validated with
one live read before it's ever stored. There is **no CLI involvement at all** — no `gnt connect`,
no walker, nothing under `apps/cli/src/prebrain/`. Content is pulled by a nightly ARQ cron job
that lives entirely in `apps/api` (`workers/tasks_zendesk.py`, `workers/tasks_intercom.py`): it
reads the customer's data with a stored token, masks it with the server-side privacy gate, calls
an LLM to extract candidate rules, and opens PRs on its own, no human CLI step required beyond the
original connect call. Copy this shape if your connector is a support/ticketing/helpdesk-style
tool where content should show up automatically rather than waiting for someone to run a local
command. **Worked example below.**

**Shape 3 — one-offs, don't copy these.** Slack and GitHub don't fit either shape above, and
neither should be your template:

- **Slack** (`apps/api/src/gnt/routers/slack.py`, `SlackConnection`) has no content walker at
  all. The `/brain` slash command turns whatever a human types directly into a draft rule
  (`create_draft_rule`) — there's no historical-message sync, no extraction pass over channel
  history.
- **GitHub** (`apps/api/src/gnt/routers/github.py`, `GithubConnection`) is the *destination* for
  approved rules (git-native storage), not a content source. Nothing reads FROM GitHub to extract
  rules; the webhook exists to detect a merged rule PR, not to walk repo content.

If your connector idea is "read prose from some tool and propose rules from it," it's Shape 1 or
Shape 2. Say which one in your connector-request issue — a maintainer will confirm before you
write code.

## The two halves, regardless of shape

Every real connector (Shape 1 or 2) splits into two independent pieces of work. You may only need
to build one of them if you're extending an existing connector (e.g. reading a new field a
connector already has a live connection for) rather than adding a brand new one.

1. **Connection lifecycle** (`apps/api`) — how gnt acquires and stores a credential for a
   customer's account: the OAuth app registration and callback, or the token-paste-and-validate
   endpoint; the `*Connection` SQLAlchemy model and its Alembic migration; encryption at rest;
   connect/disconnect surfaces.
2. **Content ingestion** — how gnt actually reads content once connected and turns it into
   candidate rules: a CLI walker (Shape 1, `apps/cli/src/prebrain/`) or a worker sync module
   (Shape 2, `apps/api/src/gnt/workers/`).

## Worked example, Shape 1: Notion

**Connection lifecycle** — `apps/api/src/gnt/routers/notion.py`, mounted at `/v1/notion`:

- `GET /v1/notion/install-url` (behind `require_admin`) returns Notion's OAuth authorize URL,
  built by `gnt/notion/oauth.py`'s `build_authorize_url`.
- `GET /v1/notion/oauth/callback` verifies the OAuth state, exchanges the code
  (`exchange_code`), encrypts the resulting access token (`gnt/notion/crypto.py`'s
  `encrypt_token`), and upserts a `NotionConnection` row keyed on `org_id` (unique — a reconnect
  overwrites, it never creates a second row).
- `GET /v1/notion/status` returns `{"connected": bool, "workspace_name": ...}` for the dashboard
  card.
- `GET /v1/notion/token` is the CLI-facing half: given a valid CLI API key, it decrypts and
  returns the org's stored access token so the CLI can do its own read/parse/chunk work locally
  with it. This is the seam between the two halves — nothing about how the token is *used* lives
  in `apps/api`.

The model, `NotionConnection` in `apps/api/src/gnt/db/models.py`, has one row per org
(`org_id` unique, upsert-on-reconnect), `access_token_encrypted` (Fernet ciphertext, never
plaintext), and `workspace_id`/`workspace_name`/`bot_id` straight from Notion's own OAuth token
response, display-only. Its migration is `apps/api/migrations/versions/0034_notion_linear_connectors.py`.
Client id/secret/state-secret/token-encryption-key live in `apps/api/src/gnt/config.py` as
`notion_client_id`, `notion_client_secret`, `notion_state_secret`, `notion_token_encryption_key` —
the naming convention every OAuth connector's settings follow (`<connector>_client_id`,
`<connector>_client_secret`, `<connector>_state_secret`, `<connector>_token_encryption_key`).

The dashboard card lives in
`apps/web/app/(account)/settings/organization/organization-settings-client.tsx`, alongside the
GitHub and Linear cards, driven by `GET /v1/notion/status`.

**Content ingestion** — `apps/cli/src/prebrain/mcp-notion.ts`. This is a thin adapter on top of
the shared connector framework in `apps/cli/src/prebrain/mcp-framework/` (read that directory's
own `README.md` in full before writing a new walker — it is itself a complete, worked
how-to-add-a-walker guide, more detailed than what's reasonable to duplicate here). The short
version: `mcp-notion.ts` declares an `McpInAdapter` object — which MCP tools it's allowed to call
(`API-post-search`, `API-retrieve-page-markdown`, `API-retrieve-a-comment`), which fields it reads
off each one's response, and a `walk(ctx, params)` function that calls those tools through `ctx`
and hands finished documents to `ctx.emitDocument()`. Everything else — spawning the vendor's MCP
server over stdio, enforcing the read-only tool allowlist, stripping any field the adapter didn't
declare, chunking, closing the connection, turning a thrown walk into a skipped-and-reported
source rather than a crashed run — is the framework runner's job
(`apps/cli/src/prebrain/mcp-framework/walker.ts`), not the adapter's.

`gnt connect notion-mcp` (`apps/cli/src/commands/connect-notion-mcp.ts`) reads a pasted Notion
integration token and saves it locally to `~/.gnt/mcp-tokens.json` after validating it with one
live read — this is a second, independent way to get a token onto the adapter, unrelated to the
dashboard OAuth flow above. If neither a local token nor an env var (`GNT_NOTION_MCP_TOKEN`) is
present, `bootstrapDashboardToken` (`mcp-framework/connect.ts`) fetches the dashboard's
OAuth-acquired token from `GET /v1/notion/token` the first time it's needed and caches it locally
— so clicking "Connect" in the dashboard is enough to make `gnt prebrain --mcp-notion` work with no
separate CLI step, but a customer who'd rather keep gnt's servers out of the picture entirely can
still `gnt connect notion-mcp` and paste their own token instead. Both paths converge on the same
adapter and the same local token store.

Linear (`apps/cli/src/prebrain/mcp-linear.ts`, `apps/api/src/gnt/routers/linear.py`,
`LinearConnection`) is the same shape end to end, with one real divergence worth knowing before
you assume Notion generalizes perfectly: Linear's CLI-side connect (`connect-linear-mcp.ts`) does
its *own* OAuth (`mcp-framework/oauth.ts`'s loopback-redirect flow, RFC 8252), registered as a
separate OAuth client from the dashboard's own Linear app — two independent client registrations
for the same vendor, not one flow reused by both surfaces. Don't assume every OAuth connector's
CLI-side connect is a plain paste-a-token flow just because Notion's is.

## Worked example, Shape 2: Zendesk

**Connection lifecycle** — `apps/api/src/gnt/routers/zendesk.py`, mounted at
`/v1/settings/zendesk`:

- `POST /v1/settings/zendesk` (behind `require_admin`) takes `{subdomain, agent_email,
  api_token}`, calls `gnt/zendesk/client.py`'s `verify_credentials` for one live read before
  anything is persisted, then encrypts the token (`gnt/zendesk/crypto.py`) and upserts a
  `ZendeskConnection` row. No OAuth callback route exists for this connector at all — the whole
  lifecycle is one POST.
- `GET /v1/settings/zendesk` returns connection status; `DELETE /v1/settings/zendesk` removes it.
- `GET /v1/settings/zendesk/sync-status` surfaces the nightly sync's last-run health
  (`gnt/zendesk_sync_status.py`) — last success, last error, items scanned, candidates proposed.

`ZendeskConnection` (`apps/api/src/gnt/db/models.py`) stores `subdomain`, `agent_email`, and
`api_token_encrypted` (its own Fernet key, `zendesk_token_encryption_key` in `config.py` — never
shared with another connector's key, see that setting's own comment for why). Migration:
`apps/api/migrations/versions/0029_zendesk_connector.py`, which also creates
`zendesk_sync_states` (one row per org, current sync health) and `zendesk_processed_items`
(dedup log, see below).

**Content ingestion** — `apps/api/src/gnt/workers/tasks_zendesk.py`, an ARQ cron job, not a CLI
walker. Per org, per nightly run:

1. Skip anything already processed — `zendesk_sync_status.has_been_processed` checks a
   `(item_type, item_id, content_fingerprint)` dedup key so a large, mostly-unchanged Zendesk
   instance isn't re-extracted every night.
2. Run the raw text through the server-side privacy gate (`gnt.pipeline.privacy_gate`) *before*
   extraction, not just before storage.
3. Check the org's LLM spend quota (`gnt.llm_quota.check_llm_quota`) before spending an extraction
   call; stop the org's run, don't crash the worker, once exhausted.
4. Extract zero or more candidate rules from the masked text
   (`gnt.pipeline.content_extraction.extract_candidate_rules_async`).
5. For each candidate: `create_draft_rule` → `submit_rule_for_review` → (if the org also has
   GitHub connected) `propose_rule_for_org`, opening a PR — same draft → submit → propose
   lifecycle every other draft-rule path in this codebase uses.
6. Record the item as processed either way, so a macro with no policy content isn't re-sent to the
   model every night.

The three content types it reads — macro action text, help-center article bodies, internal notes
on recently-updated tickets — are pulled through `gnt/zendesk/client.py`, which is deliberately
narrow: every function returns one of a small set of explicitly declared dataclasses (`Macro`,
`Article`, `TicketRef`, `InternalNote`) built by reading named keys one at a time, never
`**payload`. That's what lets `tests/test_zendesk_client.py` prove — not just assert — that ticket
record fields (requester, assignee, tags, custom fields, ...) can never reach anything downstream,
because the dataclass structurally has no attribute that could hold them. This is the Python
equivalent of the CLI framework's declared-`fields` allowlist in Shape 1 — same guarantee, two
different enforcement mechanisms because the two shapes don't share code.

Intercom (`apps/api/src/gnt/routers/intercom.py`, `IntercomConnection`,
`workers/tasks_intercom.py`) is the identical shape, one step simpler: no subdomain/agent-email
pair, just a single access token, since Intercom's token alone identifies the workspace.

## The real divergence worth knowing before you build

**There is currently no CLI surface and no dashboard UI for Zendesk or Intercom.** GitHub, Notion,
and Linear all have a connect card on
`apps/web/app/(account)/settings/organization/organization-settings-client.tsx`; Zendesk and
Intercom don't (check before assuming otherwise — this may have changed by the time you read
this). Today, connecting one means calling `POST /v1/settings/zendesk` or
`/v1/settings/intercom` directly. If you're building a new Shape 2 connector, matching that
existing pattern (API + worker only, no CLI, no dashboard form) is *consistent* with what's
already shipped — it isn't a gap you're expected to fill unless a maintainer tells you to build
the dashboard card too. Ask, don't assume either way.

**Shape 1 needs a human to run something; Shape 2 doesn't.** A Notion/Linear connect only makes a
token available — content moves only when `gnt prebrain --mcp-notion` runs. A Zendesk/Intercom
connect starts content moving on its own, on the next nightly cron tick, with no further action
from anyone. If your connector idea is "should silently start proposing rules once connected," it
has to be Shape 2 (or you're signing up to build a new cron job) — Shape 1's framework has no
scheduler in it at all, on purpose (see `mcp-framework/README.md`'s own reasoning: content
walkers run on request, not on a timer, because they touch a device the customer controls, not a
server gnt operates).

## What "connected" means system-wide

`apps/api/src/gnt/routers/platform_admin.py` builds the internal dashboard's per-org connector
summary by checking each `*Connection` model directly:

```python
connectors = {
    "github": {"connected": await _connected(GithubConnection)},
    "slack": {"connected": await _connected(SlackConnection)},
    "zendesk": {"connected": await _connected(ZendeskConnection)},
    "intercom": {"connected": await _connected(IntercomConnection)},
    "notion": {"connected": await _connected(NotionConnection)},
    "linear": {"connected": await _connected(LinearConnection)},
}
```

A new connector's model needs a matching entry here (or platform-admin just won't show it) — this
is the one place that enumerates every connector by name; there's no registry it reads from
automatically the way the CLI's `mcp-framework/registry.ts` works for walkers.

## Checklist for a new connector PR

- [ ] Confirmed with a maintainer (via the connector-request issue) which shape this is —
      OAuth+CLI-walker or token+server-sync — before writing code.
- [ ] `*Connection` model in `apps/api/src/gnt/db/models.py`, `org_id` unique (reconnect upserts,
      never a second row), plus its Alembic migration under `apps/api/migrations/versions/`.
- [ ] Own dedicated Fernet encryption key in `apps/api/src/gnt/config.py`
      (`<connector>_token_encryption_key`) and its own `crypto.py` module
      (`gnt/<connector>/crypto.py`) — never reuse another connector's key, even one that looks
      similar in value/sensitivity.
- [ ] Decide RLS eligibility for the new table(s): if something has to look the row up by an
      external id *before* an org_id is known (a webhook payload, a slash command's team id), it
      can't have RLS, same as `slack_connections`/`github_connections`. If every read is already
      inside a `scope_to_org`'d session (no inbound webhook), it should follow the standard
      tenant-isolation policy, same as `zendesk_connections`/`notion_connections`. Get this wrong
      and you either leak across orgs or can't resolve the org at all.
- [ ] Token/credential validated with one live read *before* it's ever written to disk or DB
      (`verify_credentials` on the API side, `runConnectFlow`'s validate-before-save on the CLI
      side) — never save a credential that hasn't proven it works.
- [ ] Never store or log the raw token anywhere past the encrypt call — API responses return
      `connected: true`, never the token, not even encrypted.
- [ ] Shape 1: adapter added to `MCP_IN_ADAPTERS` in `mcp-framework/registry.ts`, `walker` value
      added to the `PrebrainWalker` union in `apps/cli/src/prebrain/types.ts`, `gnt connect
      <id>-mcp` / `gnt disconnect <id>-mcp` wired into `apps/cli/src/index.ts`, declared `reads`
      exhaustively covering every field actually touched (this is the whole privacy boundary —
      see `mcp-framework/README.md`'s own "Declare your reads" section).
- [ ] Shape 2: new content read through explicitly declared dataclasses/fields, never a raw
      `**payload` passthrough (see `gnt/zendesk/client.py`), so a declared-fields test can prove
      sensitive record fields never reach extraction. Server-side privacy gate applied to raw text
      *before* the extraction LLM call, never after. Dedup/processed-item table so a nightly sync
      doesn't re-extract unchanged content forever. `check_llm_quota` checked before every
      extraction call.
- [ ] Platform-admin's `connectors` dict in `routers/platform_admin.py` updated for the new
      connection model.
- [ ] Tests: a declared-fields test proving undeclared/sensitive fields are unreachable (the
      framework harness for Shape 1, a hand-written test like
      `tests/test_zendesk_client.py` for Shape 2), plus whatever the router/adapter's own logic
      needs. `ruff check` + `pytest` for `apps/api` changes, the CLI's own test runner for
      `apps/cli` changes — see CONTRIBUTING.md's "Test and lint" section.
- [ ] If this touches `apps/cli/src/prebrain/extraction/`, note in the PR description that
      `extraction-eval.yml` skips its live-model gate on a fork PR — run `bun run eval:extraction
      -- --mode cloud` locally and paste the numbers, per CONTRIBUTING.md.

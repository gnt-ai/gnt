# gnt.ai API — Bruno collection

A [Bruno](https://www.usebruno.com) collection covering every real HTTP surface of
`apps/api`: auth/key management, git-native rules, the published MCP endpoint (all five
tools), the generic webhook, billing, gaps/ROI, org offboarding, and apps/store's
internal API. One request per meaningful endpoint, every request asserts a status code
plus at least one response-shape check — this is a contract test, not a scratchpad.

## The rule

**Every new API endpoint or MCP tool ships its `.bru` request in the same PR that adds
it.** If your PR touches `apps/api/src/gnt/routers/`, `apps/api/src/gnt/mcp_server/`, or
`apps/store/src/http/server.ts`, it isn't done until the matching request (or an update
to an existing one) lands here too. Point reviewers at this section.

## Opening the collection

**Bruno app**: File → Open Collection → select this `bruno/` directory.

**`bru` CLI**: `npm install -g @usebruno/cli`, then run from inside `bruno/` (the CLI
only runs from a collection root):

```bash
cd bruno
bru run auth/whoami.bru --env local
bru run rules -r --env local          # a whole folder, recursively
```

## Environments

`environments/local.bru` and `environments/production.bru` set `api_base_url`,
`mcp_url`, and `store_base_url`. Every credential (`cli_api_key`, `mcp_api_key`,
`webhook_token`, `store_internal_secret`, `session_jwt`) is set to
`{{process.env.GNT_BRUNO_*}}` — Bruno's env-var interpolation, resolved from your real
shell environment at run time. **No `.bru` file in this collection, including the
environment files themselves, ever carries a literal key or token string** — CI enforces
this (`.github/workflows/security.yml`'s `gitleaks` job greps `bruno/**/*.bru` for
real-looking secret shapes on every PR).

`environments/production.bru` ships with no real deploy addresses: `api_base_url`
resolves from `GNT_BRUNO_API_BASE_URL` at run time (empty by default — `bru run
--env production` fails loudly until you export it), and `store_base_url` is a
placeholder (`your-store-host.example.com`) since a store deployment is
private-network-only anyway (see the `store-internal/` section). Point
`GNT_BRUNO_API_BASE_URL` at wherever you've deployed `apps/api`, same as you'd
export the `GNT_BRUNO_*` credentials below for that environment.

Export what you need before running:

```bash
export GNT_BRUNO_API_BASE_URL=https://...   # production only — your deployed apps/api origin
export GNT_BRUNO_CLI_KEY=gnt_live_...       # an is_admin=true key (cli-type)
export GNT_BRUNO_MCP_KEY=gnt_live_...       # an org-scoped key (mcp-type)
export GNT_BRUNO_WEBHOOK_TOKEN=whk_...      # for webhooks/ingest.bru
export GNT_BRUNO_STORE_SECRET=...           # STORE_INTERNAL_API_SECRET, for store-internal/
export GNT_BRUNO_SESSION_JWT=...            # a live Better Auth session JWT (see below)
export GNT_BRUNO_TEST_ORG_ID=...            # production only — the test org's Better Auth id
```

Minting `GNT_BRUNO_CLI_KEY`/`GNT_BRUNO_MCP_KEY` for a fresh org: `POST /v1/settings/mcp-keys`
mints a non-admin key with any existing key or a session; `gnt login` is the normal way
to get an admin (`is_admin=true`) cli-key. For local dev without any org set up yet, the
fastest path is inserting a row directly into `mcp_api_keys` — see the PR that added
this collection for the exact `sha256(plaintext)` insert used to validate it.

### `session_jwt` and what it can't do

A handful of endpoints (`POST /v1/settings/cli-key`, `.../cli-keys/{id}/rotate`,
`POST /v1/org/offboarding/request` and `.../confirm`) are gated on
`require_session`/`require_admin_session` — they deliberately refuse an API key and only
accept a live Better Auth session JWT (`apps/web`'s `/api/auth/token`), closing the
self-escalation path an API key minting another, more capable key would otherwise open.
This collection has no way to drive a real browser login, so it can't mint one for you.
Paste a real session JWT into `GNT_BRUNO_SESSION_JWT` to exercise these for real;
left blank (the default), every one of them 401s cleanly on the JWT decode step — which
is itself the correct, asserted behavior for "no session," not a broken test.

## Destructive / test-org-only requests

Never run these against an org whose data you want to keep. Never include them in an
automated "run everything" pass. Each is named `DESTRUCTIVE — ...` and carries its own
warning in the request's `docs` block:

- **`org-admin/offboarding-confirm.bru`** — permanently deletes every rule, gap,
  finding, ROI counter, key, and log the org has, plus its entire rules mirror.
  Irreversible. Requires a real `session_jwt` and the token
  `org-admin/offboarding-request.bru` just issued to do anything at all.
- **`store-internal/delete-org-source.bru`** — the store-side half of the same
  operation, wipes an org's entire git-native rules mirror directly, with no
  confirmation gate at this layer (the gate lives one level up, in the org-admin flow
  above).

`billing/cancel.bru` schedules a real Stripe subscription cancellation and sends a real
email — not irreversible, but a genuine external side effect against whatever Stripe
account the target deploy is configured with. Treat it the same way: test org, run
deliberately, never in an automated pass.

`billing/checkout.bru` and `billing/portal.bru` also create real Stripe objects
(a Checkout Session / a Billing Portal session) — lower stakes than `cancel`, but still
excluded from the smoke-run list below for the same "no unattended external side
effects" reason.

`mcp/check-action.bru` makes a real, billed LLM call (Haiku-tier) on every invocation
and counts against the org's monthly `check_action` cap (1500/month on the base plan) —
safe to run, but not something to spend on every automated pass. Excluded from the
smoke-run list for cost, not risk.

## Running a safe subset (no tags — read why below)

Bruno's `--tags`/`--exclude-tags` flags exist, but the `.bru` `meta { }` block's `tags:`
field parses as a plain string in the currently pinned `bru` CLI (3.5.2), not a real
array — `--exclude-tags` silently does nothing against it. Rather than depend on a
version bump to fix that, this collection selects safe subsets by listing exact file
paths, which `bru run` already supports natively and doesn't depend on any tag feature
working correctly.

The exact set `.github/workflows/deploy.yml`'s post-deploy smoke job runs — read-only,
no LLM cost, no Stripe/webhook/store side effects, safe to run unattended against a real
test org on every deploy:

```bash
cd bruno
bru run \
  auth/whoami.bru auth/cli-key-poll.bru auth/cli-key-list.bru auth/cli-key-revoke.bru \
  auth/mcp-key-list.bru auth/webhook-token-list.bru \
  billing/status.bru billing/payment-method.bru billing/invoices.bru \
  gaps-roi/gaps.bru gaps-roi/roi-summary.bru \
  mcp/search-rules.bru mcp/get-rule.bru mcp/list-skill-packs.bru mcp/get-skill-pack.bru \
  rules/list-rules.bru rules/staleness-due.bru \
  --env production
```

For a full local run against everything except the destructive/store-internal requests
(needs a running `apps/api` + `apps/store`, and `GNT_BRUNO_SESSION_JWT` left blank is
fine — the session-gated requests assert the 401 case):

```bash
cd bruno
bru run . -r --env local
```

## `rules/` and `auth/`'s mcp-key and webhook-token requests chain

`rules/create-rule.bru` through `rules/staleness-due.bru` walk one draft rule through
its real lifecycle (create → get → submit → propose → batch-propose → reject →
deprecate → edit), each request reading the previous one's id via a runtime var
(`{{last_rule_id}}`, set in a `script:post-response` block). Same pattern in `auth/`
for `mcp-key-mint` → `mcp-key-rotate` → `mcp-key-revoke` and `webhook-token-mint` →
`webhook-token-revoke` — mint-then-clean-up throwaway credentials rather than touching
your real `{{mcp_api_key}}`. Run these folders in order (or the whole collection) for
the chains to hold; running a single file out of order will fail on a missing var, not
silently no-op.

## `store-internal/` is local/private-network only

`apps/store` has no public domain in a typical production deploy — `apps/api` reaches
it over your hosting platform's private network rather than a public URL, which is also
why the post-deploy smoke job never touches this folder. `environments/production.bru`'s
`store_base_url` is a placeholder for that reason: whatever address you put there has to
actually be reachable from wherever you run `bru`, which a private-network-only address
generally isn't. Run this folder against `--env local` with `apps/store` running locally
(`bun run serve`, see `apps/store/README.md`).

`store-internal/` deliberately skips `POST /sources` (register a GitHub source) and
`POST /sync` — both need a real GitHub PAT and repo to mean anything, which isn't
something this collection provisions.

## What's out of scope

Slack, GitHub connect/webhook, Zendesk, Intercom, transcribe, brain, and skill-pack
download endpoints aren't covered here — this collection tracks the surfaces called out
when it was built (auth, rules, the published MCP endpoint, webhooks, billing, gaps/ROI,
org admin, apps/store's internal API), not the full router list. Extending coverage to
the connectors is a reasonable follow-up, not an oversight.

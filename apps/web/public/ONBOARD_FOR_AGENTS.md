# gnt.ai onboarding guide

Setup reference for the `gnt` CLI (npm package `@gnt-ai/cli`, source at
github.com/lukaadzic/GNT-AI). Hosted at gntai.dev, not gnt.ai — that domain
currently points elsewhere and isn't under this project's control; gntai.dev
is the real one.

## What this does

gnt.ai is a git-native rules layer for AI teams — terminal-first, no dashboard.
What an org knows lives as versioned rules in their own GitHub repo, reviewed by a
human, and shipped as real pull requests. Nothing here is "approved" until a human
merges a PR on GitHub.

Setting gnt.ai up for a team normally goes through, in order:

1. Installing the `gnt` CLI
2. Logging in
3. Connecting Slack (optional) and GitHub (required)
4. Running `gnt prebrain` with the operator to draft the org's first rules
5. Reviewing anything else the operator wants to add by hand
6. Connecting an MCP-capable agent to the org's approved rules, so something
   actually enforces them

Three of these steps need the operator there in person, by construction: `gnt
connect github` opens a browser for the operator to install and authorize the
GitHub App themselves, `gnt prebrain` opens with a short company-profile Q&A,
and `gnt review` is a single-keypress UI (`j`/`k`/`a`/`r`). `gnt review` checks
for a TTY and errors out ("needs an interactive terminal") if invoked without
one — that's not a suggestion, the process exits. `gnt prebrain` has no such
check; run without anyone there to answer its questions, it just blocks on
stdin indefinitely.

## Step 1: Install the CLI

```bash
npm install -g @gnt-ai/cli
```

Verify:

```bash
gnt --help
```

This should print the `gnt.ai` command list (`login`, `connect`, `status`,
`review`, `pull`, ...). If `gnt` isn't found, npm's global bin directory
probably isn't on `PATH` — restart the shell or check `npm config get prefix`.

## Step 2: Log in

```bash
gnt login
```

This opens a browser window for the operator to sign in. What happens next
depends on whether they already have a gnt.ai account:

- **Already signed in** (they just finished sign-up, or have used gnt.ai
  before): the browser tab confirms and closes almost immediately, and the
  CLI prints `Logged in.` within a few seconds. Move on to the verify step
  below.
- **Brand new** (no account yet): the browser walks them through sign-up and
  naming their organization — and once that's done, it lands them on their
  onboarding page, **not** back at this command. `gnt login` has nothing to
  catch that return trip and will sit on "Waiting for you to sign in…" for
  up to 5 minutes before timing out with an error. That's expected, not a
  bug — tell the operator this up front so an apparently-stuck command
  doesn't read as broken. Once they confirm they've finished creating their
  organization, **run `gnt login` again** (Ctrl-C the first one first if
  it's still waiting) — this second run completes instantly, since they're
  now already signed in.

Wait for the CLI to print:

```
Logged in. Credentials saved to ~/.gnt/credentials.json
```

Verify:

```bash
gnt status
```

This should print brain status (skill pack version, connector state) instead of
an auth error. If it errors, `gnt login` didn't complete — re-run it.

## Step 3 (ask the operator first): Connect Slack — optional

Before running anything, ask the operator: **"Do you want to connect Slack now,
or skip this step?"** Connecting Slack needs them to authorize gnt.ai inside their
own Slack workspace, and it's genuinely optional — the rest of this flow works
fully without it.

If they want to connect it:

```bash
gnt connect slack
```

This opens a browser for Slack OAuth consent and waits for the operator to finish
there.

Verify: the command prints `Slack connected.` when it detects the connection. If
it times out waiting, re-check with:

```bash
gnt status
```

and confirm "Slack connected" reads yes.

If the operator says skip, do nothing here and move on to Step 4.

## Step 4 (hands to the operator): Connect GitHub — required

This step is **not optional** — the rules PRs opened in Steps 5 and 6 need a
connected repo to open against.

`gnt connect github` opens a browser to GitHub's own install page for the
gnt.ai GitHub App, which means it needs the operator there to finish the
install themselves. Don't run this command. Instead, tell the operator
directly:

> Run `gnt connect github` in your own terminal now. It'll print an install
> URL and open it in your browser — pick the repo you want rules PRs opened
> against (just that one repo, not your whole account) and confirm the
> install on GitHub's side. The CLI polls in the background and picks it up
> once you're done.

The GitHub App only ever asks for three permissions: **Contents**
(read/write, to read a rule file and write the branch a proposal opens on),
**Pull requests** (read/write, to open/read/close the PRs that carry every
proposal and approval), and **Metadata** (read-only, GitHub's forced
minimum for any App). No org, issues, actions, or admin scope. Installation
tokens are minted per request and expire within the hour — nothing
long-lived sits in gnt's database the way a pasted personal access token
used to. The webhook that confirms a merge is managed by the App itself,
not something the operator registers by hand.

Also tell the operator to turn on **branch protection** for this repo's
default branch (GitHub repo settings → Branches → require a pull request
before merging, at minimum restricting who can merge) if it isn't on
already. gnt.ai treats "a PR got merged" as the entire proof that a human
reviewed and approved that rule — without branch protection, anyone with
push access can merge their own PR straight through with no review at all.

Wait for the operator to confirm they've done it before moving on. They should
see:

```
Connected to https://github.com/<owner>/<repo> via the GitHub App (<default_branch>).
```

If they hit an error, the message names the problem (failed install, bad
key, network) — have them retry.

(The old pasted-token flow still exists behind `gnt connect github --pat`,
and an org already on it can move to the App with
`gnt connect github --upgrade` — but the App install above is the default
and what you should tell the operator to run.)

## Step 5 (hands to the operator): Run `gnt prebrain` to draft the org's first rules

`gnt prebrain` is the fast path to the org's first rules — it replaces drafting
rules one at a time by hand. It walks whichever local sources you point it at,
extracts candidate rules from what looks like real policy or decision-making,
and opens them as batched, review-ready pull requests against the org's
connected repo directly. You don't need `gnt review` afterward for anything it
drafts — it already carries each batch through to an opened PR itself.

Before any source text reaches a model, it runs through a local privacy gate
(deterministic detectors, then NER) that replaces emails, keys, SSNs, and
similar with typed placeholders — this runs on-device regardless of
extraction mode, and it's why `--mode cloud`'s "leaves the machine" only
ever means the masked, placeholder-substituted text, not the raw source. A
third layer (a local-model contextual pass, for identifiers that only read
as personal in context) is planned but not active yet — it's a documented
no-op today, and `gnt prebrain` says so on every run rather than claiming
coverage it doesn't have. Source code is `apps/cli/src/privacy-gate/` in the
repo linked above if you want to read it rather than take this paragraph's
word for it.

The common case is the one you're already in: you're the agent, sitting in the
repo you're helping this customer set up, so the plain command with no flags
already scans that repo. A few flags matter if there's more to point it at:

- `--docs <path>` — a directory of markdown/text docs to scan alongside the repo
- `--notion <path>` — a Notion "Markdown & CSV" export `.zip`
- `--all` — turns on every connector the operator has already run
  `gnt connect <source>` for (Notion, Linear, Jira, monday, Sentry, Granola,
  Zoom, Figma comments, GitLab threads, Datadog notebooks, HubSpot notes,
  Airtable), pulled live instead of from a static export. Only widens which
  already-connected sources get scanned — never connects anything itself, and
  a source the operator never connected is silently skipped, not an error.
- `--mode <cloud|local>` — which model runs extraction: `cloud` (the operator's
  own Anthropic key, the default) or `local` (their own Ollama daemon, nothing
  leaves their machine). Ask the operator which they'd rather use before
  suggesting a command with `--mode local` and an `--ollama-host`.

Before it scans anything, `gnt prebrain` opens with a short company-profile
pass — under a minute, up to four questions about what the company does, which
functions run on AI agents, and where decisions and policy currently live. Its
answers steer which rules matter and how they get tagged, so they need to be
real. This is exactly the same "genuinely interactive, don't drive it yourself"
situation as Step 4 and Step 6: don't run `gnt prebrain` yourself. Tell the
operator directly:

> Run `gnt prebrain` in your own terminal now. Add `--docs <path>` and/or
> `--notion <path.zip>` if you've got docs or a Notion export worth scanning,
> or `--all` to pull live from whatever you've already connected with
> `gnt connect <source>` — ask them which other tools your team actually uses
> (Linear, Jira, GitLab, Figma, HubSpot, and more are all supported) if they
> haven't connected anything beyond GitHub yet. It'll ask a few quick
> questions about the company first, then scan, extract, and open pull
> requests for whatever it finds.

Wait for the operator to confirm the run finished. What they'll see at the end
is a `Summary:` block — chunks scanned, candidate rules extracted, and PRs
opened, each with its URL and rule count (e.g. `Opened PR: <url> (6 rules)`).
Ask them to note those PR URLs — you'll want the count in Step 7.

## Step 6 (hands to the operator): Review and propose anything else by hand

`gnt review` is still here for rules added outside a `gnt prebrain` run — a
one-off policy someone remembers later, something drafted by hand. It's a raw
single-keypress UI (`j`/`k` to navigate, `a` to propose, `r` to reject) — like
`gnt connect github`, it needs a real terminal and will refuse to run ("needs an
interactive terminal") if you invoke it yourself as the agent. It's also a
human-approval gate by design: every rule that ships should be a decision the
operator made themselves, not one relayed through you. Don't run this command.
Instead, tell the operator directly:

> Run `gnt review` in your own terminal now. It walks through anything awaiting
> review one item at a time — `j`/`k` to move between items, `a` to propose
> (opens a real pull request), `r` to reject and discard it.

Wait for the operator to confirm they've gone through the whole list (or skip
this step entirely if there's nothing left to review). Ask them to note each PR
URL printed (`Opened PR: <url>`) — you'll want the count in Step 7.

## Step 7: Verify and hand off

```bash
gnt status
```

Confirm the number of PRs opened in Steps 5 and 6 matches what you expect.

Then hand off to the human explicitly: tell the operator to **review and merge
the pull requests opened above, on GitHub.** A rule isn't live until its PR is
merged — a merged PR is what makes a rule real. That's intentional, not a bug:
gnt.ai treats a merged PR as the actual approval record, and nothing in this flow
merges on your behalf.

Once the operator merges those PRs, the org has its first approved rules. Five
merged in this session is what the `/welcome` page's checklist is watching
for, but merging even one is real progress — nothing about this flow requires
hitting that number in one sitting.

## Step 8: Connect yourself (the agent) so something enforces these rules

Everything above gets rules approved. Nothing above connects an agent to
actually check anything against them — that's this step, and unlike Steps 4-6
it doesn't need the operator. If you're reading this file because you speak
MCP (Claude Code does), mint a key and connect yourself directly:

```bash
gnt keys create
```

This is non-interactive and prints the endpoint alongside a fresh key:

```
MCP URL: https://api.gntai.dev/mcp/
Key:     gnt_live_xxxxxxxxxxxxxxxx
```

It's shown once — use it right away. For Claude Code:

```bash
claude mcp add gnt-brain <MCP URL> --header "Authorization: Bearer <key>"
```

Verify:

```
✓ gnt-brain connected · 5 tools ready
```

Then confirm it actually works, not just that it connected: call `check_action`
with a plain-English description of something one of the rules merged in Step
7 covers (e.g. "refund order #8021, placed 90 days ago" if a refund-window rule
went in). You should get back a real verdict — `allowed`, `blocked`, or
`needs_human` — citing that rule, not an error. If it errors, the MCP key or
URL is wrong; re-run `gnt keys create` and try again.

Connecting only makes the five tools available — nothing makes an agent
actually call `check_action` before it acts on its own. Add that discipline
now: a `PreToolUse` hook if your harness supports one, or a system-prompt
instruction otherwise, telling it to call `check_action` before anything
side-effectful and to treat a missing or unclear verdict as "don't proceed,"
never as permission. Ready-to-paste versions of both, plus the config shape
for MCP clients other than Claude Code, are at gntai.dev/docs (Connect,
Enforce, and Other clients tabs).

Only after this step is gnt.ai actually governing what an agent does —
everything before it was rules sitting in a repo, unused.

# MCP-in connector framework

This directory is the shared machinery behind every "MCP-in" connector:
`gnt` connecting out, as a client, to a customer's own vendor MCP server
(Notion, monday.com, and the nine more in the connector sprint) to read
prose and turn it into candidate rules. A new connector is one adapter file
plus its test fixtures. Everything else (connecting, the read-only
allowlist, stripping undeclared fields, chunking, provenance, closing the
connection, skip-and-report on failure) is handled here, once, for all of
them.

Worked examples to read alongside this guide: `../mcp-notion.ts` (no
per-run parameters) and `../mcp-monday.ts` (takes a list of board ids).

## What the framework guarantees, so your adapter cannot break it

Every adapter inherits these. They are enforced by the runner in
`walker.ts`, not by your adapter remembering to do them:

1. **Privacy gate.** Your adapter returns `PrebrainChunk`s to the same
   `collectChunks` path in `../../commands/prebrain.ts` that every walker
   uses. That path runs every chunk through `applyPrivacyGate` before any
   model call, in both cloud and local extraction modes. There is no code
   path from a framework walker to a model that skips the gate. Do not add
   one.
2. **Prose only.** For a structured read, the framework strips every field
   your adapter did not declare before your code ever sees the response. An
   undeclared record field (an email, a phone number, a pipeline value) is
   gone, not just unread. See "Declare your reads" below.
3. **Read-only allowlist.** Your adapter can only call the tools it lists in
   `reads`. Anything else is refused before it reaches the server, so a
   write tool cannot be called even by name, even by a future edit.
4. **Uniform provenance.** Each chunk carries the `sourcePath` you set on the
   document it came from. A short quoted excerpt is added later, downstream,
   from the chunk text, so you never build that yourself.
5. **Skip and report.** If your walk throws, the framework still closes the
   connection, and `collectChunks` turns the failure into a skipped,
   reported source. One bad source never aborts a `gnt prebrain` run.

## The one thing you export: an `McpInAdapter`

Your adapter file declares a single `McpInAdapter` object and a thin public
walker wrapper. Import everything from `./mcp-framework/index.js` (or
`../prebrain/mcp-framework/index.js` from a command).

```ts
import { chunkText } from "./chunk.js";
import { buildProseDocument } from "./mcp-framework/document.js";
import { resolveMcpToken, runMcpInWalk } from "./mcp-framework/walker.js";
import type { McpInAdapter, PrebrainChunk } from "./mcp-framework/types.js";
import type { McpToolClient } from "./mcp-connector.js";

export class MissingLinearMcpTokenError extends Error {
  constructor() {
    super("No Linear MCP token found. Run `gnt connect linear-mcp`, pass --linear-mcp-token, or set GNT_LINEAR_MCP_TOKEN.");
    this.name = "MissingLinearMcpTokenError";
  }
}

export const linearAdapter: McpInAdapter<{ teamIds: string[] }> = {
  id: "linear-mcp",                    // mcp-tokens.json key + `gnt connect linear-mcp`
  walker: "mcp-linear",                // must be added to PrebrainWalker in ../types.ts
  label: "Linear",                     // shown in messages and `gnt status`
  tokenEnvVar: "GNT_LINEAR_MCP_TOKEN", // token fallback env var
  missingTokenError: () => new MissingLinearMcpTokenError(),
  server: (token) => ({
    label: "Linear",
    command: "npx",
    args: ["-y", "<vendor-mcp-package>"],
    env: { LINEAR_API_KEY: token },    // only what this one child needs
  }),
  reads: [
    { tool: "list_issues", kind: "structured", fields: ["issues", "id", "title"] },
    { tool: "get_issue", kind: "prose" },
    { tool: "list_comments", kind: "structured", fields: ["comments", "body"] },
  ],
  chunker: chunkText,                  // or a format-specific chunker
  probe: { tool: "list_issues", args: { first: 1 } },
  async walk(ctx, { teamIds }) {
    // ... see "Write the walk" below
  },
};
```

### Fields on the adapter

- `id`: stable string, used as the token-storage key, the `gnt connect
  <id>` name, and the health-line key. Use it everywhere so a typo is one
  wrong constant, not a silent cross-file mismatch.
- `walker`: the tag stamped on every chunk. Add your value to the
  `PrebrainWalker` union in `../types.ts` (and to `WALKER_LABELS` /
  `WALKER_ORDER` in `../../commands/prebrain.ts` if you want it summarized).
- `tokenEnvVar`: checked after an explicit token and before a stored one.
- `missingTokenError`: return your own typed error so callers keep catching
  a specific class with a helpful message.
- `server(token)`: how to spawn the vendor's MCP server over stdio. Put
  only this one child's credential in `env`. Never pass the CLI's own
  environment. Prefer an env var over a `-t <token>` argv entry, which is
  visible in the process list.
- `probe`: one declared read used by the connect flow to validate a token
  before saving it.

### Declare your reads (this is the prose-only boundary)

`reads` is both your allowlist and your field declaration. Each entry is
one tool:

- `{ tool, kind: "prose" }`: the tool returns a text document (a page's
  markdown, a transcript). The framework returns that text as-is. Read it
  with `ctx.readProse(tool, args)`. Declare a tool prose only when its whole
  response is the content you want.
- `{ tool, kind: "structured", fields: [...] }`: the tool returns records
  (search hits, comments, issues). The framework parses the JSON and keeps
  only the keys in `fields`, recursively, before your code sees it. Read it
  with `ctx.readStructured(tool, args)`. `fields` is the exhaustive set of
  object keys you read across the whole response tree, including container
  keys you descend through (for example `"issues"`, `"comments"`).

The set is flat and applies at every depth. Traversal only descends into a
value whose own key you declared, so a nested record object (a contact, an
author) is dropped whole unless you explicitly declare its container key.
Declaring a leaf like `"body"` does not expose a `"body"` buried inside an
object you did not declare. If a vendor tool can return sensitive records,
this is what keeps them unreachable: declare only the prose fields and the
containers you need, and the records are gone before your parse runs.

### Write the walk

`walk(ctx, params)` is the only place you touch the server, and only through
`ctx`. You never hold the raw client, so you cannot route around the
allowlist or the field stripping.

```ts
async walk(ctx, { teamIds }) {
  for (const teamId of teamIds) {
    const listing = await ctx.readStructured("list_issues", { teamId, first: 50 });
    for (const issue of parseIssues(listing)) {           // parse the stripped data
      const description = await ctx.readProse("get_issue", { id: issue.id });
      let comments = "";
      try {
        comments = parseComments(await ctx.readStructured("list_comments", { issueId: issue.id }));
      } catch {
        // a read this source can't complete (permissions) still yields the body
      }
      const body = buildProseDocument(issue.title, description.trim(), comments);
      ctx.emitDocument({ body, sourcePath: issue.url ?? `issues/${issue.id}` });
    }
  }
}
```

- `ctx.readStructured` / `ctx.readProse` enforce the allowlist and the
  declared kind. Calling an undeclared tool, or the wrong kind, throws.
- `buildProseDocument(title, body, comments)` assembles the common heading +
  body + optional "## Comments" shape. Use it so your chunk output matches
  the existing connectors.
- `ctx.emitDocument({ body, sourcePath })`: hand the framework a finished
  document. It chunks the body with your `chunker`, tags each chunk with
  your `walker`, and sets `sourcePath` as the provenance. An empty-bodied
  document is dropped. For `sourcePath`, use a vendor deep link where one
  exists (a page or issue URL), otherwise a stable id path that mirrors how
  the vendor addresses the item (for example `boards/<id>/items/<id>`).
- Parse defensively. You usually cannot verify a vendor's exact response
  shape against a live server at build time, so try the plausible field
  names and drop an entry you cannot parse rather than failing the run.

### The public walker wrapper

Expose the same shape `commands/prebrain.ts` already calls, so wiring a new
source into the pipeline is one option plus one `deps` entry, not a new code
path.

```ts
export interface WalkMcpLinearOptions {
  token?: string;
  storedToken?: string;
  teamIds: string[];
  connect?: (token: string) => Promise<McpToolClient>; // test seam
}

export function walkMcpLinear(options: WalkMcpLinearOptions): Promise<PrebrainChunk[]> {
  if (options.teamIds.length === 0) return Promise.resolve([]); // short-circuit before connecting
  return runMcpInWalk(linearAdapter, {
    token: options.token,
    storedToken: options.storedToken,
    connect: options.connect,
    params: { teamIds: options.teamIds },
  });
}
```

If your connector has no per-run parameters (like Notion), use `void` for
the params type and pass `params: undefined`.

## Pick a chunker

`chunker` is `(content: string) => TextChunk[]`. The shared `chunkText`
(`../chunk.ts`) is the default and fits any prose. If your content needs a
format-specific splitter (a transcript chunker built for speaker turns, a
mail chunker that strips quoted history), set `chunker` to that function
instead. Nothing else changes.

## Register the connector

Add your adapter to `MCP_IN_ADAPTERS` in `registry.ts`. That is what makes
it show up in every surface that iterates all connectors, starting with the
`gnt status` health line, with no per-connector branch anywhere.

## Health reporting in `gnt status`

You do not touch `status.ts`. Registering your adapter (above) is enough:
`status.ts` renders a "connected: yes/no" line for every entry
`mcpConnectorHealth()` returns, which is every registered adapter. Because
an MCP-in token lives only on this device, "connected" means "a token is
stored locally"; there is no server-side record to query, by design.

## Connect and disconnect commands

Reuse the flow in `connect.ts`. Your `gnt connect <id>-mcp` command calls
one of two flows depending on how the vendor issues credentials, both
ending in the same validate-before-save contract: nothing is written to
`~/.gnt/mcp-tokens.json` unless the resulting token proves itself with one
real read against the live server (your adapter's `probe`) first.

For a vendor whose customers paste their own long-lived key (Notion,
monday), use `runConnectFlow`, which reads a masked token from the
terminal:

```ts
import { runConnectFlow } from "../prebrain/mcp-framework/index.js";
import { notionAdapter } from "../prebrain/mcp-notion.js";

export async function connectNotionMcp(): Promise<void> {
  const saved = await runConnectFlow({
    adapter: notionAdapter,
    commandName: "gnt connect notion-mcp",
    intro: "Create an internal integration, then paste its secret below.",
    tokenPrompt: "Notion integration token: ",
    savedHint: "Run `gnt prebrain --mcp-notion` to read from it.",
  });
  if (!saved) process.exit(1);
}
```

For a vendor with a real OAuth app registry, prefer `runOAuthConnectFlow`
instead -- it drives the RFC 8252 loopback-redirect flow (`oauth.ts`) so
the customer clicks "authorize" in their browser instead of copy/pasting a
key, and hands the resulting access token through the same validate/save
tail:

```ts
import { runOAuthConnectFlow } from "../prebrain/mcp-framework/index.js";
import { linearAdapter } from "../prebrain/mcp-linear.js";

export async function connectLinearMcp(): Promise<void> {
  const saved = await runOAuthConnectFlow({
    adapter: linearAdapter,
    commandName: "gnt connect linear-mcp",
    intro: "Opening your browser to authorize gnt with Linear...",
    oauth: {
      authorizationEndpoint: "https://linear.app/oauth/authorize",
      tokenEndpoint: "https://api.linear.app/oauth/token",
      clientId: LINEAR_OAUTH_CLIENT_ID, // a registered OAuth app's client id -- not a secret, but requires the vendor's own dev-console registration first
      scope: "read",
      port: 51901, // fixed, matches this app's registered redirect URI
      callbackPath: "/callback",
    },
    savedHint: "Run `gnt prebrain --mcp-linear` to read from it.",
  });
  if (!saved) process.exit(1);
}
```

Registering the OAuth app itself (getting a `clientId`) is an
external-account action against the vendor's own developer console, not
something this framework can do for you -- see `connect-linear-mcp.ts`'s
own doc comment for how it handles that being unset.

`runDisconnectFlow({ adapter, revoke? })` removes the local token and, if
you pass a `revoke` callback, calls the vendor's revocation API first. A
revoke failure never blocks removing the local token. Customer-issued
tokens (like Notion's and monday's) have no revoke API, so most adapters
omit `revoke` and disconnect is purely local.

Wire both commands into `../../index.ts` next to the existing
`connect notion-mcp` / `connect monday-mcp` entries.

## Write the test with the harness

Import the harness from `test/prebrain/mcp-framework/harness.js`. It gives
you a fake MCP client and the standard assertions so you only supply
fixtures.

```ts
import { expect, test } from "bun:test";
import { linearAdapter } from "../../src/prebrain/mcp-linear.js";
import {
  assertChunksWellFormed,
  assertCredentialsNeverLogged,
  assertDeclaredFieldsStripUndeclared,
  assertReadOnlyAllowlistEnforced,
  walkAdapterWithFake,
} from "./mcp-framework/harness.js";

test("only calls read-only tools on the allowlist", () => {
  assertReadOnlyAllowlistEnforced(linearAdapter);
});

test("strips undeclared record fields from a structured read", () => {
  assertDeclaredFieldsStripUndeclared(
    linearAdapter,
    "list_issues",
    { issues: [{ id: "1", title: "Keep", assignee_email: "leak@x.com" }] },
    ["leak@x.com"], // must not survive the field projection
  );
});

test("never logs the token", async () => {
  await assertCredentialsNeverLogged(linearAdapter, {
    responses: { list_issues: () => ({ issues: [] }) },
    params: { teamIds: ["t1"] },
    token: "secret-linear-token",
  });
});

test("walks fixtures into well-formed chunks", async () => {
  const { chunks } = await walkAdapterWithFake(linearAdapter, {
    responses: {
      list_issues: () => ({ issues: [{ id: "1", title: "Refund policy", url: "https://linear.app/i/1" }] }),
      get_issue: () => "Refunds over $500 require manager approval.",
      list_comments: () => ({ comments: [{ body: "Confirmed by finance." }] }),
    },
    params: { teamIds: ["t1"] },
  });
  assertChunksWellFormed(linearAdapter, chunks);
  expect(chunks.map((c) => c.text).join("\n")).toContain("manager approval");
});
```

`walkAdapterWithFake` returns `{ chunks, calls, logs }` so you can also
assert exactly which tools ran. Use `mcpError("...")` as a handler's return
value to simulate a tool-level failure and prove your walk skips over it.
See `framework.test.ts` for these assertions run against a synthetic adapter
and against the real Notion and monday adapters.

## Checklist for a new connector

- [ ] Verify the vendor's current MCP tool names against their live server.
      Stale hardcoded names are the top way these break.
- [ ] Add the `walker` value to `PrebrainWalker` in `../types.ts`.
- [ ] Declare `reads`: allowlist plus, for structured tools, the exact
      fields. Declare only prose fields and the containers you traverse.
- [ ] Emit documents with a real deep-link `sourcePath` where the vendor
      supports one.
- [ ] Register the adapter in `registry.ts`.
- [ ] Add `gnt connect <id>-mcp` (via `runConnectFlow`) and wire it into
      `../../index.ts`.
- [ ] Add the walker option and `deps` entry in `../../commands/prebrain.ts`.
- [ ] Write the test with the harness. The declared-fields test must prove
      the vendor's sensitive record fields are unreachable.

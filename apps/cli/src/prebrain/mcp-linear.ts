// Live-Linear adapter: reads issue descriptions
// and comments, plus project documents, from customer-chosen teams and
// projects through Linear's own official MCP server -- an issue's title
// and description become a rule's title-shaped source content, its
// comment thread becomes the decision-prose candidate, same split
// mcp-monday.ts already applies to a board item and its updates.
//
// Since the connector-framework refactor this is a thin adapter, same as
// mcp-notion.ts and mcp-monday.ts: it declares its server, its read-only
// allowlist, and the fields it reads, then walks the teams/projects it's
// given. The framework owns connecting, allowlist enforcement, stripping
// undeclared fields, chunking, closing, and skip-and-report on failure.
//
// -- Which Linear MCP offering this connects to, and why the server spec
// below looks different from Notion's/monday's --
// Linear does not publish a local, npx-runnable MCP server the way Notion
// (@notionhq/notion-mcp-server) and monday.com (@mondaydotcomorg/monday-api-mcp)
// do. Linear's only official offering is a centrally hosted remote server
// at https://mcp.linear.app/mcp (linear.app/docs/mcp), which normally
// expects an interactive OAuth 2.1 browser flow -- exactly the shape
// mcp-notion.ts's own doc comment already rejected for Notion's hosted
// endpoint, because standing up that flow would put gnt's own
// infrastructure in the read path. Linear's docs also state the same
// endpoint accepts a plain customer-issued API key or OAuth token as a
// static `Authorization: Bearer <token>` header, bypassing the interactive
// flow entirely -- functionally the same "customer pastes a token" shape
// every other adapter in this framework uses, just over HTTP instead of a
// spawned local process reading an env var.
//
// The framework's `server(token)` contract only spawns a local process
// over stdio (StdioMcpServerSpec), so this adapter can't hand it a bare
// HTTPS URL. Linear's own docs solve exactly this case for stdio-only
// clients: they document running the endpoint through `mcp-remote`
// (npm, github.com/geelen/mcp-remote), a stdio-to-HTTP bridge, as the
// generic-client setup instructions on linear.app/docs/mcp. That bridge
// process still spawns and runs entirely on the customer's own device --
// it makes the HTTPS call to mcp.linear.app itself, gnt's servers are
// never a party to it -- so the trust boundary this whole framework
// depends on holds; only the transport between "spawned local process"
// and "Linear's server" changed from a raw stdio MCP server to one hop
// through a documented bridge. `mcp-remote` supports the static-token
// case via `--header "Authorization:${VAR}"` with the actual value passed
// through `env`, never `args` -- kept that way here for the same reason
// mcp-monday.ts's own doc comment gives for preferring an env var over a
// `-t <token>` argv entry: an argv value is visible to anything that can
// read this device's process list, an env var scoped to just this one
// child is not.
//
// -- Read-only guarantee --
// LINEAR_READS below is the complete set of tools this adapter ever
// calls: list_teams (probe only), list_issues, get_issue, list_comments,
// list_documents, get_document. Linear's own docs describe the server as
// having tools for "finding, creating, and updating" issues, projects, and
// comments, without an official published tool catalog -- the read tool
// names above are corroborated by independent third-party documentation
// of the live server (not vendor prose alone), but nothing here was
// confirmed against a real workspace; see the honest-limit paragraph
// below. Whatever the create/update tool names turn out to be, none of
// them appear in LINEAR_READS, and the framework refuses any tool outside
// this declared set even if a future edit tried.
//
// -- Honest limit on what's verified here --
// This codebase has no Linear workspace or API key to test against, so
// (like mcp-notion.ts) the exact JSON shape each tool returns is not
// confirmed live. Field/argument names below follow Linear's own SDK and
// API convention (camelCase: teamId, projectId, issueId, not monday's
// snake_case) as the most plausible guess, and parsing is deliberately
// defensive -- multiple plausible field names per value, an entry that
// doesn't parse is dropped rather than failing the run. This is flagged as
// a real risk in this task's PR description, not papered over; see
// mcp-linear.test.ts for what IS verified (this adapter's
// parsing/allowlist/error-handling contract against a fake client).
//
// -- Chunking: no dedicated ticket/comment-thread chunker --
// buildProseDocument already gives an issue the same shape every other
// MCP-in adapter's document gets: a title heading, the issue's own prose,
// then an optional "## Comments" heading. The shared chunkText already
// treats a markdown heading as a hard chunk boundary, so a decision stated
// in an issue's description and one confirmed later in a comment already
// land in separate chunks without any bespoke turn-taking logic -- and
// there is no comment author to preserve a turn structure around in the
// first place, since prose-only field stripping drops each comment's
// author before this file ever sees it. A comment thread here ends up
// structurally identical to what mcp-monday.ts already does for an item's
// updates: one joined block of comment bodies under its own heading. A
// dedicated chunker was considered and not built for this reason -- the
// Jira adapter should make the same call unless its own tool responses
// turn out to carry a shape this reasoning doesn't cover.
import { chunkText } from "./chunk.js";
import { buildProseDocument } from "./mcp-framework/document.js";
import { resolveMcpToken, runMcpInWalk } from "./mcp-framework/walker.js";
import type { McpAdapterContext, McpInAdapter, PrebrainChunk } from "./mcp-framework/types.js";
import type { McpToolClient } from "./mcp-connector.js";

const LINEAR_READS = [
  // Probe-only: a minimal, scope-free read used to validate a token before
  // saving it (see the adapter's `probe` field below). Never called from
  // the walk itself -- team/project scoping there comes entirely from
  // customer-supplied ids, same "no auto-discovery" reasoning mcp-monday.ts
  // documents for boards.
  { tool: "list_teams", kind: "structured", fields: ["teams", "nodes", "id", "name", "key"] },
  { tool: "list_issues", kind: "structured", fields: ["issues", "nodes", "id", "identifier", "title", "url"] },
  { tool: "get_issue", kind: "structured", fields: ["id", "identifier", "title", "description", "url"] },
  { tool: "list_comments", kind: "structured", fields: ["comments", "nodes", "body"] },
  { tool: "list_documents", kind: "structured", fields: ["documents", "nodes", "id", "title", "url"] },
  { tool: "get_document", kind: "structured", fields: ["id", "title", "content", "body", "url"] },
] as const;

// Same "seed a first rulebook, don't mirror the whole workspace" reasoning
// as mcp-notion.ts's MAX_PAGES and mcp-monday.ts's MAX_ITEMS_PER_BOARD.
const MAX_ISSUES_PER_SCOPE = 50;
const MAX_DOCUMENTS_PER_PROJECT = 50;

export class MissingLinearMcpTokenError extends Error {
  constructor() {
    super(
      "No Linear MCP token found. Run `gnt connect linear-mcp`, pass --linear-mcp-token, " +
        "or set GNT_LINEAR_MCP_TOKEN.",
    );
    this.name = "MissingLinearMcpTokenError";
  }
}

interface LinearIssue {
  id: string;
  title: string;
  url?: string;
}

interface LinearDocument {
  id: string;
  title: string;
  url?: string;
}

// list_issues' response is expected to be a JSON object with an `issues`
// array, or a Relay-style `nodes` array under either key, depending on
// server version -- both declared in LINEAR_READS. Runs against the
// framework-stripped response; an entry missing an id is dropped.
function parseIssues(data: unknown): LinearIssue[] {
  const list = extractList(data, ["issues", "nodes"]);
  const issues: LinearIssue[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const id = obj.id;
    if (typeof id !== "string" || !id) continue;
    const title = typeof obj.title === "string" ? obj.title : "Untitled issue";
    const url = typeof obj.url === "string" ? obj.url : undefined;
    issues.push({ id, title, url });
  }
  return issues;
}

// get_issue's response is expected to be a JSON object for the one issue
// requested; its prose lives under `description`, Linear's own field name
// for an issue's body.
function parseIssueDescription(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const description = (data as Record<string, unknown>).description;
  return typeof description === "string" ? description.trim() : "";
}

// list_comments' response is expected to be a JSON object with a
// `comments` (or Relay-style `nodes`) array; each comment's own text lives
// under `body`, Linear's own field name.
function parseComments(data: unknown): string {
  const list = extractList(data, ["comments", "nodes"]);
  const lines: string[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const body = (entry as Record<string, unknown>).body;
    if (typeof body === "string" && body.trim()) lines.push(body.trim());
  }
  return lines.join("\n\n");
}

// list_documents' response mirrors list_issues' shape: a `documents` (or
// `nodes`) array of summary entries, each with enough to look up full
// content afterward.
function parseDocuments(data: unknown): LinearDocument[] {
  const list = extractList(data, ["documents", "nodes"]);
  const documents: LinearDocument[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const id = obj.id;
    if (typeof id !== "string" || !id) continue;
    const title = typeof obj.title === "string" ? obj.title : "Untitled document";
    const url = typeof obj.url === "string" ? obj.url : undefined;
    documents.push({ id, title, url });
  }
  return documents;
}

// get_document's response is expected to be a JSON object for the one
// document requested; its prose lives under `content` or `body` depending
// on server version, both declared in LINEAR_READS.
function parseDocumentContent(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const obj = data as Record<string, unknown>;
  const content = (typeof obj.content === "string" && obj.content) || (typeof obj.body === "string" && obj.body);
  return content ? content.trim() : "";
}

// Shared "array, or {key: array}, or {nodes: array}" extraction every
// parse function above needs -- same defensive multi-shape handling
// mcp-notion.ts's parseSearchResults and mcp-monday.ts's parseBoardItems
// already apply, factored here once since this file needs it four times.
function extractList(data: unknown, containerKeys: readonly string[]): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  for (const key of containerKeys) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  return [];
}

function issueSourcePath(issue: LinearIssue): string {
  return issue.url ?? `issues/${issue.id}`;
}

function documentSourcePath(document: LinearDocument): string {
  return document.url ?? `documents/${document.id}`;
}

async function walkIssue(ctx: McpAdapterContext, issue: LinearIssue): Promise<void> {
  const description = parseIssueDescription(await ctx.readStructured("get_issue", { id: issue.id }));

  let commentsText = "";
  try {
    commentsText = parseComments(await ctx.readStructured("list_comments", { issueId: issue.id }));
  } catch {
    // Comments are a bonus, not the point of the walk -- an issue this
    // integration can read but can't list comments on (permissions, no
    // comments yet) still yields its own title and description.
  }

  const body = buildProseDocument(issue.title, description, commentsText);
  ctx.emitDocument({ body, sourcePath: issueSourcePath(issue) });
}

async function walkIssuesInScope(ctx: McpAdapterContext, args: Record<string, unknown>): Promise<void> {
  const listing = await ctx.readStructured("list_issues", { ...args, limit: MAX_ISSUES_PER_SCOPE });
  const issues = parseIssues(listing).slice(0, MAX_ISSUES_PER_SCOPE);
  for (const issue of issues) {
    await walkIssue(ctx, issue);
  }
}

async function walkDocument(ctx: McpAdapterContext, document: LinearDocument): Promise<void> {
  const content = parseDocumentContent(await ctx.readStructured("get_document", { id: document.id }));
  if (!content) return; // nothing to emit -- an empty document is dropped the same way an empty body is anywhere else
  const body = buildProseDocument(document.title, content, "");
  ctx.emitDocument({ body, sourcePath: documentSourcePath(document) });
}

async function walkProjectDocuments(ctx: McpAdapterContext, projectId: string): Promise<void> {
  let documents: LinearDocument[] = [];
  try {
    documents = parseDocuments(
      await ctx.readStructured("list_documents", { projectId, limit: MAX_DOCUMENTS_PER_PROJECT }),
    ).slice(0, MAX_DOCUMENTS_PER_PROJECT);
  } catch {
    // Project docs are a bonus, not the point of the walk -- a project
    // this integration can read issues for but not documents (permissions,
    // no docs tool support) still yields all of its issues.
    return;
  }
  for (const document of documents) {
    await walkDocument(ctx, document);
  }
}

export interface LinearWalkParams {
  teamIds: string[];
  projectIds: string[];
}

// The adapter object the framework runs and the registry lists. Everything
// Linear-specific lives here; nothing here re-implements a framework
// guarantee.
export const linearAdapter: McpInAdapter<LinearWalkParams> = {
  id: "linear-mcp",
  walker: "mcp-linear",
  label: "Linear",
  tokenEnvVar: "GNT_LINEAR_MCP_TOKEN",
  // The web dashboard's own Linear connector (apps/api's routers/linear.py,
  // OAuth sprint T14) -- see mcp-notion.ts's own doc comment on
  // dashboardTokenPath/bootstrapDashboardToken for the full reasoning,
  // identical here: gnt's servers are only ever in the credential-
  // acquisition path, never in the read path this adapter's server()
  // still runs entirely on the customer's own device.
  dashboardTokenPath: "linear",
  missingTokenError: () => new MissingLinearMcpTokenError(),
  server: (token) => ({
    label: "Linear",
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp", "--header", "Authorization:${LINEAR_MCP_AUTH_HEADER}"],
    env: { LINEAR_MCP_AUTH_HEADER: `Bearer ${token}` },
  }),
  reads: LINEAR_READS,
  chunker: chunkText,
  // "limit", not "first" -- confirmed live against the real hosted server
  // (list_teams/list_issues/list_documents all reject an unrecognized
  // "first" key outright, a 32602 input-validation error, not a silent
  // ignore). This was originally guessed from Relay-style GraphQL cursor
  // pagination conventions, which this REST-shaped MCP tool surface
  // doesn't actually follow.
  probe: { tool: "list_teams", args: { limit: 1 } },
  async walk(ctx, { teamIds, projectIds }) {
    // list_issues filters by "team"/"project" (accepts a name or an id),
    // not "teamId"/"projectId" -- confirmed live. Translated here, at the
    // call site, rather than renaming LinearWalkParams's own fields: every
    // other adapter in this framework (and commands/prebrain.ts's own
    // flags) uses the Id-suffixed convention for a caller-supplied scope,
    // and this is Linear's tool-argument quirk to absorb, not a reason to
    // make this adapter's public option shape inconsistent with the rest.
    for (const teamId of teamIds) {
      await walkIssuesInScope(ctx, { team: teamId });
    }
    for (const projectId of projectIds) {
      await walkIssuesInScope(ctx, { project: projectId });
      await walkProjectDocuments(ctx, projectId);
    }
  },
};

// The exported resolve helper stays for the prebrain barrel -- delegates to
// the framework's shared precedence (explicit token, then GNT_LINEAR_MCP_TOKEN,
// then a stored token, else MissingLinearMcpTokenError) rather than
// re-deriving it here.
export function resolveLinearMcpToken(explicit: string | undefined, storedToken: string | undefined): string {
  return resolveMcpToken(linearAdapter, explicit, storedToken);
}

export interface WalkMcpLinearOptions {
  token?: string;
  storedToken?: string;
  /** Which teams to read issues from -- customer-supplied, never auto-discovered (same reasoning as mcp-monday.ts's boardIds). */
  teamIds: string[];
  /** Which projects to read issues and documents from -- customer-supplied, never auto-discovered. */
  projectIds: string[];
  /** Injectable seam for tests -- defaults to a real stdio connection through the mcp-remote bridge. */
  connect?: (token: string) => Promise<McpToolClient>;
}

// Public walker: the same shape commands/prebrain.ts already calls for the
// other two MCP-in walkers. The empty-scope short-circuit stays here,
// ahead of the framework runner, so a run with neither teams nor projects
// never resolves a token or opens a connection.
export function walkMcpLinear(options: WalkMcpLinearOptions): Promise<PrebrainChunk[]> {
  if (options.teamIds.length === 0 && options.projectIds.length === 0) return Promise.resolve([]);
  return runMcpInWalk(linearAdapter, {
    token: options.token,
    storedToken: options.storedToken,
    connect: options.connect,
    params: { teamIds: options.teamIds, projectIds: options.projectIds },
  });
}

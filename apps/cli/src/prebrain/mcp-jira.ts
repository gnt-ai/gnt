// Live-Jira adapter: reads issue summaries,
// descriptions, and comments from customer-chosen projects through
// Atlassian's own official MCP server. Built after mcp-linear.ts, on the
// assumption it would need the same shape (allowlist: projects) and could
// reuse its comment-thread chunker -- see the "Chunking" section below
// for whether that reuse actually held once Jira's real tool shape was
// checked, and the "Content format" section for the one place it didn't.
//
// -- Which Jira MCP offering this connects to, and why the server spec
// below looks like mcp-linear.ts's, not mcp-notion.ts's/mcp-monday.ts's --
// Atlassian does not publish a local, npx-runnable MCP server the way
// Notion and monday.com do. Its official offering is a centrally hosted
// remote server (github.com/atlassian/atlassian-mcp-server,
// atlassian.com/platform/remote-mcp-server) at
// https://mcp.atlassian.com/v1/mcp/authv2, supporting both an interactive
// OAuth 2.1 browser flow and a static, customer-issued API token sent as a
// plain `Authorization: Bearer <token>` header -- corroborated by
// Atlassian's own support docs (support.atlassian.com/atlassian-rovo-mcp-server)
// and the server's own repo, not vendor prose alone, though (like
// mcp-linear.ts) nothing here was confirmed against a live Atlassian site.
// The static-token path is exactly the "customer pastes a token, the whole
// read path stays on their own device" shape every other adapter in this
// framework uses, over HTTP instead of a spawned local process reading an
// env var -- so this adapter reaches it the same way mcp-linear.ts reaches
// Linear's own hosted server: through `mcp-remote` (npm,
// github.com/geelen/mcp-remote), a stdio-to-HTTP bridge that still spawns
// and runs entirely on the customer's own device. See mcp-linear.ts's own
// doc comment for the full trust-boundary argument; it applies unchanged
// here, only the target URL and header value differ.
//
// One documented difference from Linear's token model worth flagging up
// front: Atlassian's support docs describe the static-API-token path as
// admin-gated ("Admin enablement required", "Scoped tokens mandatory") for
// this specific remote MCP server, unlike a Linear personal API key which
// any workspace member can self-serve. `gnt connect jira-mcp`'s intro text
// says this plainly rather than promising a self-serve flow this adapter
// can't guarantee; see connect-jira-mcp.ts.
//
// -- Read-only guarantee --
// JIRA_READS below is the complete set of tools this adapter ever calls:
// getAccessibleAtlassianResources (probe only), searchJiraIssuesUsingJql,
// getJiraIssue. Atlassian's own supported-tools documentation lists these
// alongside write tools with different names entirely (createJiraIssue,
// editJiraIssue, addCommentToJiraIssue, addWorklogToJiraIssue,
// transitionJiraIssue) -- none of those appear in JIRA_READS, and the
// framework refuses any tool outside this declared set even if a future
// edit tried.
//
// -- Content format: the one place Linear's reasoning didn't transfer as-is --
// Linear's own comment thread and issue description arrive as plain
// strings; this adapter's own honest-limit paragraph below is what makes
// clear that isn't something this task could simply assume held for Jira
// too. Jira's issue model is built on Atlassian Document Format (ADF), a
// structured JSON node tree, for rich-text fields (description, comment
// bodies) -- unlike Linear's markdown-string fields, an ADF value is a
// JSON object, and handing that object straight into buildProseDocument/
// chunkText the way Linear's plain-string content flows through would
// chunk on JSON punctuation, not prose structure, and would carry every
// node's raw attrs (a mentioned user's Atlassian account id, a media file
// id) into what's supposed to be prose-only content.
//
// This adapter always asks getJiraIssue for responseContentFormat:
// "markdown" -- a parameter documented on the live server (see
// github.com/atlassian/atlassian-mcp-server/issues/145, a bug report whose
// own reproduction steps describe requesting either "adf" or "markdown"
// for a description/comment body) -- so the common case is already a plain
// string requiring no further work, same as Linear's fields. But that same
// bug report is itself evidence the parameter isn't reliably honored on
// every issue (the reporter's repro shows the hang "happens regardless of
// responseContentFormat"), and this codebase has no live Jira site to
// confirm it always is, so every description/comment body this adapter
// reads goes through adf-to-text.ts's adfToPlainText either way:
// adfToPlainText returns a string input trimmed and unchanged (the fast
// path once markdown is honored), and walks an object input as an ADF node
// tree, keeping only visible text -- see that file's own doc comment for
// the node-by-node handling and what it deliberately drops (mention
// account ids, media attrs).
//
// -- Chunking: does Linear's "no dedicated chunker" call hold here too? --
// Yes, for the document-assembly shape, once the ADF step above has
// already turned description/comments into plain strings. buildProseDocument
// still gives a Jira issue the exact same title-heading / body / optional
// "## Comments" heading shape Linear's own issue gets, and chunkText still
// treats a markdown heading as a hard chunk boundary -- nothing about
// *that* reasoning depended on which vendor produced the plain string, only
// on the string existing, which is what adf-to-text.ts's job is. What did
// need adjusting is upstream of the chunker, not the chunker choice itself:
// Linear's plain fields need no conversion step before buildProseDocument
// ever sees them; Jira's need adfToPlainText first. Once through that step,
// mcp-jira.ts's own document shape and this file's own comment-thread
// handling are structurally identical to mcp-linear.ts's, so no dedicated
// chunker was built here either, for the same reason Linear's own doc
// comment gives.
//
// One further structural difference from Linear worth naming plainly:
// Linear's server exposes issue comments through their own list_comments
// tool, called separately from get_issue, so a comments-only failure
// (permissions, no comments yet) degrades gracefully while the issue's own
// title/description still come back -- see mcp-linear.ts's walkIssue. The
// Atlassian server's getJiraIssue instead returns comments embedded in the
// same response as the issue's own fields (confirmed from the issue #145
// bug report above: "Comments are included as part of the standard issue
// response"), so there is no separate call to isolate a comments-only
// failure from -- a getJiraIssue call that fails for any reason skips that
// whole issue, same as an issue this adapter's Linear counterpart can't
// read via get_issue at all (mcp-linear.ts's own walkIssue doesn't wrap
// that call in a try/catch either, for the same reason: only the read this
// task can genuinely make optional -- Linear's separate list_comments call
// -- gets that treatment).
//
// -- Scope: projects, plus a cloud id neither Linear nor Sentry needed --
// The plan's own text calls for a --jira-projects flag mirroring
// --linear-teams/--linear-projects, and that's what --mcp-jira takes for
// *content* scope: every tool call here is scoped to a customer-given
// project key, never auto-discovered, same "customer supplies the exact
// list" bias as every other adapter's board/team/project ids. What the
// plan's text didn't anticipate is that Atlassian's MCP server is
// multi-site: unlike Linear (one API key, one implicit workspace) or
// Sentry (an org slug plus project slugs, which its own adapter already handles),
// every Jira-specific tool call on this server needs to know *which*
// Atlassian site (cloudId) to route to, and there is no tool this adapter
// can safely call to auto-discover that -- getAccessibleAtlassianResources
// would work, but calling it from inside the walk to resolve a cloud id
// the customer already knows would be exactly the "auto-discovery" every
// other adapter in this framework deliberately avoids for scope, not just
// for content. So --jira-cloud-id is a second required flag alongside
// --jira-projects, not something this task's own checklist mentioned --
// flagged here plainly, and in the PR, as the one place Jira's real shape
// forced an addition beyond "same shape as Linear."
//
// A customer can pass either their Atlassian site URL
// (https://yourteam.atlassian.net) or a raw cloud id GUID as that value;
// atlassian-mcp-server's own README documents "Specific CloudId (e.g.,
// https://yoursite.atlassian.net)" as the example value for the same
// concept, suggesting the server accepts a site URL directly. This
// adapter passes whatever the customer gave straight through as the
// `cloudId` argument on every tool call either way, and separately uses
// it (only when it looks like a URL) to build this walk's own deep links --
// see issueSourcePath below for why that's the *reliable* way to get one,
// rather than trusting an Atlassian REST "self" link, which this adapter
// never even declares as a field it reads.
//
// -- Honest limit on what's verified here --
// Like mcp-linear.ts, this codebase has no live Atlassian site or API
// token to test against, so the exact JSON shape searchJiraIssuesUsingJql
// and getJiraIssue return is not confirmed live. The shape assumed below
// (an issue keyed by `key`, fields nested under a `fields` object,
// comments nested under `fields.comment.comments`) follows Jira's own
// long-published REST API v3 issue representation, which every Jira MCP
// wrapper this task's research turned up (including community servers
// mirroring the same tool surface) is built on top of -- the most
// plausible guess available, not a live-confirmed one. Parsing is
// deliberately defensive for the same reason mcp-linear.ts's own parse
// functions are: a shape that doesn't match what's expected is dropped
// rather than guessed at, never thrown over.
import { adfToPlainText } from "./adf-to-text.js";
import { chunkText } from "./chunk.js";
import { MANAGED_OAUTH_TOKEN } from "./mcp-framework/connect.js";
import { buildProseDocument } from "./mcp-framework/document.js";
import { resolveMcpToken, runMcpInWalk } from "./mcp-framework/walker.js";
import type { McpAdapterContext, McpInAdapter, PrebrainChunk } from "./mcp-framework/types.js";
import type { McpToolClient, StdioMcpServerSpec } from "./mcp-connector.js";

const JIRA_READS = [
  // Probe-only: validates a token/OAuth session works before any project or
  // cloud id is known -- takes no required arguments, same "no scope needed
  // to validate a credential" reasoning as mcp-linear.ts's list_teams probe
  // and mcp-sentry.ts's find_organizations probe. Never called from the
  // walk itself; its response is never parsed.
  { tool: "getAccessibleAtlassianResources", kind: "structured", fields: ["id", "name", "url"] },
  // Listing only reads enough to look up each issue's full content
  // afterward: its own key (Jira's human-facing identifier, used in every
  // JQL query and browse URL) and a title to fall back on if the detail
  // read comes back without a summary.
  { tool: "searchJiraIssuesUsingJql", kind: "structured", fields: ["issues", "key", "fields", "summary"] },
  // The declared field set here is wider than searchJiraIssuesUsingJql's on
  // purpose: description/comment bodies can arrive as ADF (a nested JSON
  // node tree) rather than a plain string -- see this file's own "Content
  // format" section above. type/content/text/attrs/marks are ADF's own
  // structural keys, needed so adfToPlainText has a tree to walk at all
  // when that happens; they carry no meaning outside an ADF value. `self`
  // (Jira's REST API resource link, not a page a human can open) is
  // deliberately never declared -- see issueSourcePath below.
  {
    tool: "getJiraIssue",
    kind: "structured",
    fields: [
      "url",
      "browseUrl",
      "fields",
      "summary",
      "description",
      "comment",
      "comments",
      "body",
      "type",
      "content",
      "text",
      "attrs",
      "marks",
    ],
  },
] as const;

// Same "seed a first rulebook, don't mirror the whole project's issue
// history" reasoning as mcp-linear.ts's MAX_ISSUES_PER_SCOPE.
const MAX_ISSUES_PER_PROJECT = 50;

// Only reached when server() spawns mcp-remote with no static
// Authorization header (see MANAGED_OAUTH_TOKEN's own doc comment) -- that
// child process then has to run its own interactive browser OAuth login
// before it can answer this connection's `initialize` at all, which the
// SDK's normal 60s handshake timeout was never sized for. Matches
// oauth.ts's own REDIRECT_WAIT_TIMEOUT_MS so every "give the customer time
// to click through a browser" wait in this codebase agrees.
const MANAGED_OAUTH_CONNECT_TIMEOUT_MS = 5 * 60 * 1000;

export class MissingJiraMcpTokenError extends Error {
  constructor() {
    super(
      "No Jira MCP token found. Run `gnt connect jira-mcp`, pass --jira-mcp-token, " +
        "or set GNT_JIRA_MCP_TOKEN.",
    );
    this.name = "MissingJiraMcpTokenError";
  }
}

interface JiraIssueSummary {
  key: string;
  title?: string;
}

interface JiraIssueDetail {
  summary: string;
  description: string;
  comments: string;
  url?: string;
}

// Shared "array, or {key: array}" extraction, same defensive shape-handling
// mcp-linear.ts's own extractList applies (kept as a separate copy here,
// not imported, the same way each adapter file keeps its own parse helpers
// private -- see mcp-sentry.ts for the same convention).
function extractList(data: unknown, containerKeys: readonly string[]): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  for (const key of containerKeys) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  return [];
}

// A rich-text field is either already a plain string (responseContentFormat
// honored) or an ADF node object (it wasn't) -- see this file's own
// "Content format" section for why both are handled here rather than
// assumed to be one or the other.
function richText(value: unknown): string {
  return adfToPlainText(value);
}

// searchJiraIssuesUsingJql's response is expected to hold an `issues` array
// of `{ key, fields: { summary } }` entries, Jira's own REST API v3 issue
// shape -- an entry missing a key is dropped, since key (not id) is what
// every later call in this walk (getJiraIssue, the browse URL) addresses an
// issue by.
function parseIssueSummaries(data: unknown): JiraIssueSummary[] {
  const list = extractList(data, ["issues"]);
  const summaries: JiraIssueSummary[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const key = typeof obj.key === "string" ? obj.key : undefined;
    if (!key) continue;
    const fields = obj.fields && typeof obj.fields === "object" ? (obj.fields as Record<string, unknown>) : obj;
    const title = typeof fields.summary === "string" ? fields.summary : undefined;
    summaries.push({ key, title });
  }
  return summaries;
}

// getJiraIssue's response is expected to be a JSON object for the one
// issue requested, fields nested under a `fields` object per Jira's REST
// API v3 issue shape (falling back to the whole object if there's no
// nested container, in case a wrapper flattens it -- same defensive bias
// mcp-linear.ts's own parse functions apply). Comments are expected under
// `fields.comment.comments`, each with a `body` -- an entry's author is
// never declared as a read field in JIRA_READS, so it's already gone by
// the time this function runs, the same "prose-only field stripping drops
// each comment's author before this file ever sees it" guarantee
// mcp-linear.ts's own doc comment describes for Linear.
function parseIssueDetail(data: unknown): JiraIssueDetail {
  if (!data || typeof data !== "object") return { summary: "", description: "", comments: "" };
  const obj = data as Record<string, unknown>;
  const fields = obj.fields && typeof obj.fields === "object" ? (obj.fields as Record<string, unknown>) : obj;

  const summary = typeof fields.summary === "string" ? fields.summary : "";
  const description = richText(fields.description);

  const commentContainer =
    fields.comment && typeof fields.comment === "object" ? (fields.comment as Record<string, unknown>) : fields;
  const commentTexts: string[] = [];
  for (const entry of extractList(commentContainer, ["comments"])) {
    if (!entry || typeof entry !== "object") continue;
    const text = richText((entry as Record<string, unknown>).body);
    if (text) commentTexts.push(text);
  }

  const url =
    typeof obj.url === "string" ? obj.url : typeof obj.browseUrl === "string" ? obj.browseUrl : undefined;

  return { summary, description, comments: commentTexts.join("\n\n"), url };
}

// Jira's REST "self" link points at the API resource
// (.../rest/api/3/issue/10002), not a page a human can open -- this
// adapter never even declares it as a field it reads, so using it as a
// deep link isn't a temptation a future edit can reach for by accident.
// When the customer's --jira-cloud-id value looks like a site URL rather
// than a bare cloud id GUID, Jira's own long-published /browse/<KEY> route
// builds a real, reliable deep link with no guessing about undocumented
// response fields; a friendlier url/browseUrl field in the response (if
// the wrapper happens to return one) is used when no site URL was given;
// otherwise a stable id path, same "vendor URL when we have one, stable id
// path when we don't" contract every other adapter in this framework
// keeps.
function siteUrlFrom(cloudId: string): string | undefined {
  return /^https?:\/\//i.test(cloudId) ? cloudId.replace(/\/+$/, "") : undefined;
}

function issueSourcePath(cloudId: string, key: string, vendorUrl: string | undefined): string {
  const site = siteUrlFrom(cloudId);
  if (site) return `${site}/browse/${key}`;
  if (vendorUrl && /^https?:\/\//i.test(vendorUrl)) return vendorUrl;
  return `jira/${cloudId}/${key}`;
}

async function walkIssue(ctx: McpAdapterContext, cloudId: string, summary: JiraIssueSummary): Promise<void> {
  const raw = await ctx.readStructured("getJiraIssue", {
    cloudId,
    issueIdOrKey: summary.key,
    // Requested every time -- see this file's own "Content format" section
    // for why this doesn't remove the need for adfToPlainText, only makes
    // the common case a no-op for it.
    responseContentFormat: "markdown",
  });
  const detail = parseIssueDetail(raw);
  const title = detail.summary || summary.title || summary.key;
  const body = buildProseDocument(title, detail.description, detail.comments);
  ctx.emitDocument({ body, sourcePath: issueSourcePath(cloudId, summary.key, detail.url) });
}

async function walkProject(ctx: McpAdapterContext, cloudId: string, projectKey: string): Promise<void> {
  const listing = await ctx.readStructured("searchJiraIssuesUsingJql", {
    cloudId,
    // Explicit JQL, never natural language -- same "the tool's own default
    // query syntax works with or without an embedded natural-language
    // repair step" reasoning mcp-sentry.ts's own search_issues call
    // documents.
    jql: `project = "${projectKey}" ORDER BY updated DESC`,
    maxResults: MAX_ISSUES_PER_PROJECT,
  });
  const summaries = parseIssueSummaries(listing).slice(0, MAX_ISSUES_PER_PROJECT);
  for (const summary of summaries) {
    await walkIssue(ctx, cloudId, summary);
  }
}

export interface JiraWalkParams {
  cloudId: string;
  projectKeys: string[];
}

// The adapter object the framework runs and the registry lists.
export const jiraAdapter: McpInAdapter<JiraWalkParams> = {
  id: "jira-mcp",
  walker: "mcp-jira",
  label: "Jira",
  tokenEnvVar: "GNT_JIRA_MCP_TOKEN",
  missingTokenError: () => new MissingJiraMcpTokenError(),
  // Two credential shapes, one adapter: MANAGED_OAUTH_TOKEN (what `gnt
  // connect jira-mcp` now saves by default, see connect-jira-mcp.ts) means
  // "let mcp-remote authenticate itself" -- no static header at all, so
  // mcp-remote's own OAuth-discovery step runs its interactive browser
  // login against Atlassian's real auth server (auth.atlassian.com,
  // confirmed live) via dynamic client registration, no gnt-registered app
  // and no gnt-held bearer token anywhere. Any other resolved token (a
  // customer's own scoped API token, for an org whose admin has enabled
  // self-serve token creation -- see this file's own "Admin enablement
  // required" note above) still goes through as a static bearer header,
  // exactly as before this task.
  server: (token): StdioMcpServerSpec => {
    if (token === MANAGED_OAUTH_TOKEN) {
      return {
        label: "Jira",
        command: "npx",
        args: ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/mcp/authv2"],
        env: {},
        connectTimeoutMs: MANAGED_OAUTH_CONNECT_TIMEOUT_MS,
      };
    }
    return {
      label: "Jira",
      command: "npx",
      args: [
        "-y",
        "mcp-remote",
        "https://mcp.atlassian.com/v1/mcp/authv2",
        "--header",
        "Authorization:${JIRA_MCP_AUTH_HEADER}",
      ],
      env: { JIRA_MCP_AUTH_HEADER: `Bearer ${token}` },
    };
  },
  reads: JIRA_READS,
  chunker: chunkText,
  probe: { tool: "getAccessibleAtlassianResources" },
  async walk(ctx, { cloudId, projectKeys }) {
    for (const projectKey of projectKeys) {
      await walkProject(ctx, cloudId, projectKey);
    }
  },
};

// The exported resolve helper stays for the prebrain barrel -- delegates to
// the framework's shared precedence (explicit token, then GNT_JIRA_MCP_TOKEN,
// then a stored token, else MissingJiraMcpTokenError) rather than
// re-deriving it here.
export function resolveJiraMcpToken(explicit: string | undefined, storedToken: string | undefined): string {
  return resolveMcpToken(jiraAdapter, explicit, storedToken);
}

export interface WalkMcpJiraOptions {
  token?: string;
  storedToken?: string;
  /** Which Atlassian site to route every call to -- a site URL (https://yourteam.atlassian.net) or a raw cloud id GUID; required alongside projectKeys, see this file's own "Scope" section for why this adapter needs it and Linear's/monday's don't. */
  cloudId: string;
  /** Which Jira projects to read issues from -- customer-supplied, never auto-discovered (same reasoning as mcp-linear.ts's teamIds/projectIds). */
  projectKeys: string[];
  /** Injectable seam for tests -- defaults to a real stdio connection through the mcp-remote bridge. */
  connect?: (token: string) => Promise<McpToolClient>;
}

// Public walker: same shape commands/prebrain.ts already calls for the
// other MCP-in walkers. The empty-scope short-circuit mirrors
// mcp-linear.ts's/mcp-sentry.ts's own -- no cloud id or no project means
// nothing resolves a token or opens a connection.
export function walkMcpJira(options: WalkMcpJiraOptions): Promise<PrebrainChunk[]> {
  if (!options.cloudId || options.projectKeys.length === 0) return Promise.resolve([]);
  return runMcpInWalk(jiraAdapter, {
    token: options.token,
    storedToken: options.storedToken,
    connect: options.connect,
    params: { cloudId: options.cloudId, projectKeys: options.projectKeys },
  });
}

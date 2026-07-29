// Live-Sentry adapter: reads a project's issue
// titles and statuses through Sentry's own official MCP server. Same
// framework shape as mcp-notion.ts/mcp-monday.ts -- declare a server, a
// read-only allowlist, and a chunker, then walk. See this directory's
// mcp-framework/README.md for the contract this file implements.
//
// -- Which Sentry MCP server this connects to --
// Sentry publishes @sentry/mcp-server (github.com/getsentry/sentry-mcp),
// which supports a stdio transport authenticated with a plain Sentry User
// Auth Token via the SENTRY_ACCESS_TOKEN env var:
//   npx @sentry/mcp-server --access-token=<token>
// Same "customer pastes a token, the whole read path stays on their own
// device" shape as mcp-notion.ts/mcp-monday.ts use for Notion and
// monday.com -- this adapter passes the token through SENTRY_ACCESS_TOKEN
// in the spawned child's own env, not as a CLI argument, for the same "not
// visible in `ps`" reasoning connectStdioMcpServer's own doc comment
// gives.
//
// -- What this adapter reads, and why it's narrower than issue comments --
// This adapter's original scope called for postmortem and issue-comment
// prose. That scope was checked against the live getsentry/sentry-mcp reference
// server source (packages/mcp-core/src/toolDefinitions.json, surfaces.ts,
// and the individual tool handlers under tools/catalog/), not assumed from
// documentation, and two facts changed the design:
//
// 1. Only a fixed set of tool names is directly callable over a plain MCP
//    tools/call request (surfaces.ts's TOP_LEVEL_TOOL_NAMES): find_organizations,
//    find_projects, update_issue, search_events, analyze_issue_with_seer,
//    search_issues, get_sentry_resource, search_sentry_tools, and
//    execute_sentry_tool. Everything else the server exposes -- including
//    get_issue_activity (issue comments/activity feed) and get_issue_details
//    (full issue detail with stack trace, Seer analysis, and linked trace
//    data) -- is a "catalog" tool only reachable indirectly, by first
//    discovering it with search_sentry_tools and then invoking it through
//    execute_sentry_tool(name, arguments).
// 2. execute_sentry_tool determines which underlying action actually runs
//    from a runtime `name` argument, not from the outer MCP tool name.
//    Declaring execute_sentry_tool on this adapter's `reads` would satisfy
//    the framework's allowlist mechanically (the outer tool name is on the
//    list) while defeating what that allowlist exists to guarantee: a
//    write tool (add_issue_note, update_issue, resolve/assign/delete-style
//    catalog tools) could be invoked through it with nothing in
//    walker.ts/mcp-connector.ts able to see or block it, since allowlist
//    enforcement only ever inspects the outer tool name a client calls.
//    That would not be "read-only by construction" for this connector, so
//    execute_sentry_tool and search_sentry_tools are deliberately never
//    declared here -- get_issue_activity and get_issue_details are
//    unreachable through this adapter, not merely unused. This is a real
//    gap between what Sentry's current MCP server exposes and what this
//    connector framework's allowlist model can safely wrap; it's called
//    out in this task's own PR description rather than patched around
//    here, since a fix belongs in the framework (a declared-argument
//    allowlist for indirection-style tools like this one), not in a single
//    adapter file.
//
// get_sentry_resource is directly callable, but for resourceType='issue'
// it is a thin wrapper that calls the exact same handler get_issue_details
// does (see get-sentry-resource.ts's own switch statement) -- same
// stack-trace/Seer/trace exposure, so it is excluded for the same reason.
//
// What's left, and reachable without either problem above, is search_issues:
// project-scoped, read-only, event:read-scoped, and -- confirmed from its
// own handler and formatter source, not inferred -- returns an issue's
// grouped title, status, and permalink. It also bundles user/event counts,
// an assignee name, and a code "culprit" string in the same formatted
// block; SENTRY_ISSUE_BLOCK below is what keeps those out of a chunk (see
// "Prose only, and what that means here" below). No comments, no
// postmortem prose, and no stack traces are read by this connector today.
//
// -- Prose only, and what that means here --
// Every tool this server exposes -- search_issues included -- returns one
// formatted markdown text block, not JSON (confirmed from
// tools/catalog/search-issues.ts and tools/support/search-issues/formatters.ts:
// the handler builds and returns a markdown string, there is no
// structuredContent). That means the framework's structured-field
// projection (fields.ts) has nothing to strip here -- there's no JSON tree
// to walk. search_issues is declared `kind: "prose"`, and parseIssueSummaries
// below is what actually enforces "prose only" for this adapter: it
// extracts only an issue's shortId, title, status, and permalink from the
// vendor's markdown block and reconstructs a new, minimal document from
// those four fields -- the assignee name, user/event counts, and culprit
// string in the vendor's own text never reach a chunk, because this
// adapter never passes that markdown through unchanged.
//
// -- Scope control --
// Same "customer supplies the exact list, this adapter never
// auto-discovers" bias as mcp-monday.ts's board ids: organizationSlug and
// projectSlugs are required walk params, not resolved via find_organizations/
// find_projects. find_organizations is declared and used only as the
// connect flow's probe (it takes no required arguments, so it can validate
// a token before any project is known).
import { chunkText } from "./chunk.js";
import { buildProseDocument } from "./mcp-framework/document.js";
import { resolveMcpToken, runMcpInWalk } from "./mcp-framework/walker.js";
import type { McpAdapterContext, McpInAdapter, PrebrainChunk } from "./mcp-framework/types.js";
import type { McpToolClient } from "./mcp-connector.js";

const SENTRY_READS = [
  { tool: "find_organizations", kind: "prose" },
  { tool: "search_issues", kind: "prose" },
] as const;

// Same "seed a first rulebook, don't mirror the whole project's issue
// history" reasoning as mcp-notion.ts's MAX_PAGES / mcp-monday.ts's
// MAX_ITEMS_PER_BOARD.
const MAX_ISSUES_PER_PROJECT = 50;

export class MissingSentryMcpTokenError extends Error {
  constructor() {
    super(
      "No Sentry MCP token found. Run `gnt connect sentry-mcp`, pass --sentry-mcp-token, " +
        "or set GNT_SENTRY_MCP_TOKEN.",
    );
    this.name = "MissingSentryMcpTokenError";
  }
}

interface SentryIssueSummary {
  shortId: string;
  title: string;
  status: string;
  url: string;
}

// search_issues' markdown lists each issue as a "## N. [SHORTID](url)"
// heading, a "**title**" line, then a bullet list of metadata (Status,
// Category, Users, Events, Assigned to, First/Last seen, Culprit, Seer
// Actionability) -- see formatIssueResults in the reference server's
// tools/support/search-issues/formatters.ts. Only the heading's shortId/url
// and the Status bullet are read; everything else in a block (assignee
// name, user/event counts, the culprit code-location string) is walked
// past, not carried into current, so it can never reach a chunk.
const ISSUE_HEADING = /^##\s+\d+\.\s+\[([^\]]+)\]\(([^)]+)\)\s*$/;
const TITLE_LINE = /^\*\*(.+)\*\*\s*$/;
const STATUS_LINE = /^-\s+\*\*Status\*\*:\s*(.+)$/;

// Parses defensively, same bias as mcp-notion.ts/mcp-monday.ts's own parse
// functions: an issue block missing a shortId, title, or url is dropped
// rather than guessed at, since this server's exact markdown shape is
// confirmed against the reference implementation's source, not a live
// account this codebase can call.
function parseIssueSummaries(markdown: string): SentryIssueSummary[] {
  const lines = markdown.split("\n");
  const issues: SentryIssueSummary[] = [];
  let current: Partial<SentryIssueSummary> | null = null;

  const flush = () => {
    if (current?.shortId && current.title && current.url) {
      issues.push({
        shortId: current.shortId,
        title: current.title,
        status: current.status ?? "unknown",
        url: current.url,
      });
    }
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    const heading = ISSUE_HEADING.exec(line);
    if (heading) {
      flush();
      current = { shortId: heading[1], url: heading[2] };
      continue;
    }
    if (!current) continue;

    if (!current.title) {
      const title = TITLE_LINE.exec(line);
      if (title) {
        current.title = title[1];
        continue;
      }
    }

    const status = STATUS_LINE.exec(line);
    if (status) current.status = status[1];
  }
  flush();

  return issues;
}

async function walkProject(ctx: McpAdapterContext, organizationSlug: string, projectSlug: string): Promise<void> {
  const raw = await ctx.readProse("search_issues", {
    organizationSlug,
    projectSlugOrId: projectSlug,
    // Explicit Sentry query syntax, never natural language -- search_issues'
    // own handler only runs its natural-language repair step when an
    // embedded LLM provider is configured in the spawned server's env
    // (which this adapter never sets, on purpose: it isn't this
    // connector's credential to hold). Passing the tool's own default
    // query syntax directly keeps this working with or without one.
    query: "is:unresolved",
    limit: MAX_ISSUES_PER_PROJECT,
  });

  for (const issue of parseIssueSummaries(raw)) {
    const body = buildProseDocument(issue.title, `Status: ${issue.status}`, "");
    ctx.emitDocument({ body, sourcePath: issue.url || `issues/${issue.shortId}` });
  }
}

export interface SentryWalkParams {
  organizationSlug: string;
  projectSlugs: string[];
}

// The adapter object the framework runs and the registry lists.
export const sentryAdapter: McpInAdapter<SentryWalkParams> = {
  id: "sentry-mcp",
  walker: "mcp-sentry",
  label: "Sentry",
  tokenEnvVar: "GNT_SENTRY_MCP_TOKEN",
  missingTokenError: () => new MissingSentryMcpTokenError(),
  server: (token) => ({
    label: "Sentry",
    command: "npx",
    args: ["-y", "@sentry/mcp-server"],
    env: { SENTRY_ACCESS_TOKEN: token },
  }),
  reads: SENTRY_READS,
  chunker: chunkText,
  // find_organizations takes no required arguments, so it validates a
  // token before any organization/project slug is known -- the connect
  // flow runs before the walk ever asks the customer which projects to
  // read.
  probe: { tool: "find_organizations" },
  async walk(ctx, { organizationSlug, projectSlugs }) {
    for (const projectSlug of projectSlugs) {
      await walkProject(ctx, organizationSlug, projectSlug);
    }
  },
};

// The exported resolve helper stays for the prebrain barrel -- delegates to
// the framework's shared precedence (explicit token, then GNT_SENTRY_MCP_TOKEN,
// then a stored token, else MissingSentryMcpTokenError).
export function resolveSentryMcpToken(explicit: string | undefined, storedToken: string | undefined): string {
  return resolveMcpToken(sentryAdapter, explicit, storedToken);
}

export interface WalkMcpSentryOptions {
  token?: string;
  storedToken?: string;
  /** Required alongside projectSlugs -- this walker never discovers an org on its own, see this file's own doc comment. */
  organizationSlug: string;
  /** Which projects to read -- required; this walker never discovers projects on its own. */
  projectSlugs: string[];
  /** Injectable seam for tests -- defaults to a real stdio connection to @sentry/mcp-server. */
  connect?: (token: string) => Promise<McpToolClient>;
}

// Public walker: same signature shape commands/prebrain.ts already expects
// from the other MCP-in walkers. The empty-projectSlugs short-circuit
// mirrors mcp-monday.ts's empty-boardIds one -- no organization is known
// with nothing to read, so nothing resolves a token or opens a connection.
export function walkMcpSentry(options: WalkMcpSentryOptions): Promise<PrebrainChunk[]> {
  if (!options.organizationSlug || options.projectSlugs.length === 0) return Promise.resolve([]);
  return runMcpInWalk(sentryAdapter, {
    token: options.token,
    storedToken: options.storedToken,
    connect: options.connect,
    params: { organizationSlug: options.organizationSlug, projectSlugs: options.projectSlugs },
  });
}

// Live-Notion adapter: the MCP-in mirror of
// notion-export.ts -- same target content (pages, plus their comments),
// same PrebrainChunk shape, same chunkText heuristic -- but read live
// through Notion's own official MCP server instead of a static
// "Markdown & CSV" export .zip. Opt-in only: this walker only runs when
// `gnt prebrain --mcp-notion` is passed (see commands/prebrain.ts), never
// by default, because unlike every walker above it needs live network
// access and a customer-supplied credential.
//
// Since the connector-framework refactor this is a thin adapter: it
// declares its server, its read-only tool allowlist, and the fields it
// reads from each tool, then walks. Everything else -- connecting, the
// allowlist enforcement, stripping undeclared fields, chunking, closing
// the connection, turning a thrown walk into a skipped source -- is the
// framework runner's job (see mcp-framework/walker.ts). What this file
// still owns is Notion-specific: which tools to call, how its responses
// are shaped, and the auth model.
//
// -- Which Notion MCP offering this connects to, and why --
// Notion's hosted remote endpoint (https://mcp.notion.com/mcp) requires a
// browser-based OAuth flow with no static-token option at all. Notion
// also publishes an official open-source server,
// @notionhq/notion-mcp-server (github.com/makenotion/notion-mcp-server),
// that a customer runs themselves and authenticates with a plain
// Notion-issued internal-integration token (NOTION_TOKEN) -- this adapter
// spawns that server over stdio and stays on it for the actual read work
// regardless of how the token was acquired, so the read path itself never
// touches gnt's servers, same as every other prebrain walker.
//
// The token itself CAN now come from gnt's own servers, though (OAuth
// sprint T14): the web dashboard's own Notion connector
// (apps/api/src/gnt/routers/notion.py) runs the real mcp.notion.com OAuth
// flow server-side and stores the resulting access token per org, and
// this adapter's own connect flow (mcp-framework/connect.ts's
// bootstrapDashboardToken, wired via dashboardTokenPath below) fetches
// and locally caches it the first time this runs with none stored yet.
// That is a deliberate, narrower exception to the "no gnt server in the
// path" rule than the one rejected above: gnt's servers are in the
// credential-ACQUISITION path (one browser click, one token handoff),
// never in the READ path -- every actual page/comment read still happens
// from this stdio-spawned process on the customer's own device, exactly
// as before. A customer who'd rather not involve gnt's servers at all
// still can: `gnt connect notion-mcp` remains the direct
// paste-an-integration-token flow, unaffected.
//
// -- Read-only guarantee --
// NOTION_READS below is the complete set of tools this adapter ever calls:
// search, retrieve-page-markdown, list-comments. The server's own tool
// list also has 11 write tools (create-page, update-page, delete-block,
// append-block-children, ...) -- none of them appear here, and the
// framework refuses any tool outside this declared set even if a future
// edit tried. The structured reads additionally declare exactly which
// fields they touch, so nothing beyond those fields is ever read.
//
// -- Honest limit on what's verified here --
// The exact JSON shape each of these three tools returns is documented
// by Notion's own README/tool descriptions, not confirmed against a live
// server -- this codebase has no Notion workspace or integration token
// to test against. Parsing below is deliberately defensive -- multiple
// plausible field names for each value, and the walk drops a page it
// can't parse rather than failing the run. This is flagged as a real risk
// in this task's PR description, not papered over; see mcp-notion.test.ts
// for what IS verified (this adapter's parsing/allowlist/error-handling
// contract against a fake client).
import { chunkText } from "./chunk.js";
import { buildProseDocument } from "./mcp-framework/document.js";
import { resolveMcpToken, runMcpInWalk } from "./mcp-framework/walker.js";
import { tryParseJson } from "./mcp-connector.js";
import type { McpAdapterContext, McpInAdapter, PrebrainChunk } from "./mcp-framework/types.js";
import type { McpToolClient } from "./mcp-connector.js";

// Tool names below are @notionhq/notion-mcp-server's real, published names
// (confirmed live against v2.4.1's own tools/list response -- this
// package's tool naming doesn't match the plain REST endpoint names this
// file originally assumed; "search" -> "API-post-search",
// "retrieve-page-markdown" -> "API-retrieve-page-markdown",
// "list-comments" -> "API-retrieve-a-comment", despite that last one's
// singular-sounding name -- its own description is "Retrieve comments"
// and it takes a block_id plus pagination, i.e. it lists every comment on
// a block, the same operation the old name described).
const NOTION_READS = [
  // "properties" and "plain_text" added alongside the original guess
  // (confirmed live, v2.4.1): a page's title isn't a flat `title` string
  // field, it's `properties.title.title[].plain_text` -- Notion's own
  // page-object shape, one title property containing an array of rich
  // text runs. projectToDeclaredFields drops a whole container key that
  // isn't itself declared (see fields.ts's own doc comment), so without
  // "properties" here the entire title subtree was stripped before
  // parseSearchResults ever saw it -- every page came through as
  // "Untitled page".
  { tool: "API-post-search", kind: "structured", fields: ["results", "pages", "id", "page_id", "title", "name", "url", "properties", "plain_text"] },
  { tool: "API-retrieve-page-markdown", kind: "prose" },
  { tool: "API-retrieve-a-comment", kind: "structured", fields: ["plain_text", "text", "rich_text"] },
] as const;

// Caps how many pages a single run walks -- a customer's whole workspace
// can be thousands of pages, and this is meant to seed a first rulebook,
// not mirror the entire workspace in one go. Same "coarse, documented
// scope limit" reasoning as repo-scan.ts's MAX_DEPTH/MAX_FILE_BYTES.
const MAX_PAGES = 50;

export class MissingNotionMcpTokenError extends Error {
  constructor() {
    super(
      "No Notion MCP token found. Run `gnt connect notion-mcp`, pass --notion-mcp-token, " +
        "or set GNT_NOTION_MCP_TOKEN.",
    );
    this.name = "MissingNotionMcpTokenError";
  }
}

interface NotionSearchHit {
  id: string;
  title: string;
  url?: string;
}

// A page's real title lives at properties.title.title[].plain_text --
// one title property containing an array of rich text runs (usually one,
// but a title can carry more than one run if it has mixed formatting).
// Confirmed live against v2.4.1's actual API-post-search response, not
// guessed -- see this file's own NOTION_READS comment for why
// "properties" has to be declared for this to even survive the
// framework's field projection.
function extractTitle(obj: Record<string, unknown>): string | undefined {
  const properties = obj.properties;
  if (!properties || typeof properties !== "object") return undefined;
  const titleProp = (properties as Record<string, unknown>).title;
  if (!titleProp || typeof titleProp !== "object") return undefined;
  const runs = (titleProp as Record<string, unknown>).title;
  if (!Array.isArray(runs)) return undefined;
  const text = runs
    .map((run) => (run && typeof run === "object" ? (run as Record<string, unknown>).plain_text : undefined))
    .filter((t): t is string => typeof t === "string")
    .join("");
  return text || undefined;
}

// The `search` tool's response is either a JSON array of result objects
// or a JSON object with a `results`/`pages` array -- this codebase can't
// confirm which without a live call (see this file's own doc comment), so
// it tries both shapes. Runs against the framework-stripped response, so
// only the declared fields are present. Each hit needs at least an id to
// look up afterward; a hit missing one is dropped rather than guessed at.
function parseSearchResults(data: unknown): NotionSearchHit[] {
  const list: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).results)
      ? ((data as Record<string, unknown>).results as unknown[])
      : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).pages)
        ? ((data as Record<string, unknown>).pages as unknown[])
        : [];

  const hits: NotionSearchHit[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const id = obj.id ?? obj.page_id;
    if (typeof id !== "string" || !id) continue;
    const title =
      extractTitle(obj) ||
      (typeof obj.title === "string" && obj.title) ||
      (typeof obj.name === "string" && obj.name) ||
      "Untitled page";
    const url = typeof obj.url === "string" ? obj.url : undefined;
    hits.push({ id, title, url });
  }
  return hits;
}

// list-comments' response is expected to be a JSON array of comment
// objects; each comment's own text lives under one of a few plausible
// field names depending on server version, all declared in NOTION_READS.
// A non-array response yields no comment text -- comments are a bonus, not
// the point of the walk.
function extractCommentText(data: unknown): string {
  const list = Array.isArray(data) ? data : [];
  const lines: string[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const text =
      (typeof obj.plain_text === "string" && obj.plain_text) ||
      (typeof obj.text === "string" && obj.text) ||
      (typeof obj.rich_text === "string" && obj.rich_text);
    if (text) lines.push(text);
  }
  return lines.join("\n\n");
}

// API-retrieve-page-markdown's response isn't raw markdown text -- it's a
// JSON envelope, {"object":"page_markdown","id":...,"markdown":"..."},
// same MCP-tools-return-JSON-strings pattern every other tool on this
// server uses. readProse's contract (a "prose" read returns the string to
// use as-is) assumes the tool's own text IS the prose, which holds for
// every other adapter in this codebase but not this one tool -- confirmed
// live, not guessed. Unwrapped here, in this file, rather than changing
// what readProse means for every adapter over one Notion-specific quirk.
// Falls back to the raw string if it isn't the expected envelope, so a
// future server version returning plain markdown directly still works.
function extractMarkdown(raw: string): string {
  const parsed = tryParseJson(raw);
  if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).markdown === "string") {
    return (parsed as Record<string, unknown>).markdown as string;
  }
  return raw;
}

async function walkPage(ctx: McpAdapterContext, hit: NotionSearchHit): Promise<void> {
  const markdown = extractMarkdown(await ctx.readProse("API-retrieve-page-markdown", { page_id: hit.id }));

  let commentsText = "";
  try {
    commentsText = extractCommentText(await ctx.readStructured("API-retrieve-a-comment", { block_id: hit.id }));
  } catch {
    // Comments are a bonus, not the point of the walk -- a page this
    // integration can read but can't list comments on (permissions,
    // no comments tool support) still yields its own body content.
  }

  const body = buildProseDocument(hit.title, markdown.trim(), commentsText);
  ctx.emitDocument({ body, sourcePath: hit.url ?? `page/${hit.id}` });
}

// The adapter object the framework runs and the registry lists. Everything
// Notion-specific lives here; nothing here re-implements a framework
// guarantee.
export const notionAdapter: McpInAdapter = {
  id: "notion-mcp",
  walker: "mcp-notion",
  label: "Notion",
  tokenEnvVar: "GNT_NOTION_MCP_TOKEN",
  // The web dashboard's own Notion connector (apps/api's routers/notion.py,
  // OAuth sprint T14) -- lets bootstrapDashboardToken fetch and cache an
  // org's dashboard-connected token here the first time this runs with no
  // local one yet. See that function's own doc comment for the fallback
  // chain; this adapter's own resolveMcpToken precedence is unchanged.
  dashboardTokenPath: "notion",
  missingTokenError: () => new MissingNotionMcpTokenError(),
  server: (token) => ({
    label: "Notion",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    env: { NOTION_TOKEN: token },
  }),
  reads: NOTION_READS,
  chunker: chunkText,
  probe: { tool: "API-post-search", args: { query: "", filter: { property: "object", value: "page" } } },
  async walk(ctx) {
    const searchData = await ctx.readStructured("API-post-search", {
      query: "",
      filter: { property: "object", value: "page" },
    });
    const hits = parseSearchResults(searchData).slice(0, MAX_PAGES);
    for (const hit of hits) {
      await walkPage(ctx, hit);
    }
  },
};

// The exported resolve helper stays for the prebrain barrel -- delegates to
// the framework's shared precedence (explicit token, then GNT_NOTION_MCP_TOKEN,
// then a stored token, else MissingNotionMcpTokenError) rather than
// re-deriving it here.
export function resolveNotionMcpToken(explicit: string | undefined, storedToken: string | undefined): string {
  return resolveMcpToken(notionAdapter, explicit, storedToken);
}

export interface WalkMcpNotionOptions {
  token?: string;
  storedToken?: string;
  /** Injectable seam for tests -- defaults to a real stdio connection to @notionhq/notion-mcp-server. */
  connect?: (token: string) => Promise<McpToolClient>;
}

// Public walker: the same signature commands/prebrain.ts already calls,
// unchanged, so the pipeline wiring didn't move. Thin wrapper over the
// framework runner with no per-run params.
export function walkMcpNotion(options: WalkMcpNotionOptions = {}): Promise<PrebrainChunk[]> {
  return runMcpInWalk(notionAdapter, {
    token: options.token,
    storedToken: options.storedToken,
    connect: options.connect,
    params: undefined,
  });
}

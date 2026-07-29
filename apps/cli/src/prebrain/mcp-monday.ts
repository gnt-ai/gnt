// Live-monday.com adapter: reads items and their
// comments (monday.com calls a comment an "update") from customer-chosen
// boards through monday's own official MCP server -- item name/fields
// become a rule's title-shaped source content, an update's body becomes
// the decision-prose candidate. Opt-in only: this walker only runs when
// `gnt prebrain --mcp-monday --monday-boards <id>` is passed (see
// commands/prebrain.ts) -- never by default.
//
// Since the connector-framework refactor this is a thin adapter, same as
// mcp-notion.ts: it declares its server, its read-only allowlist, and the
// fields it reads, then walks the boards it's given. The framework owns
// connecting, allowlist enforcement, stripping undeclared fields,
// chunking, closing, and skip-and-report on failure.
//
// -- Auth --
// monday.com's official MCP package (@mondaydotcomorg/monday-api-mcp)
// runs locally via npx and authenticates with a plain monday.com API
// token, the same "customer pastes a token" shape mcp-notion.ts uses for
// Notion and commands/connect-github.ts already uses for a GitHub PAT.
// monday's own docs show two ways to hand it the token: a `-t <token>`
// CLI argument, or a MONDAY_TOKEN environment variable. This adapter uses
// the env var deliberately, not the CLI argument -- a token passed as a
// child-process argv entry is visible to anything that can read the
// process list on this device (`ps`), an env var passed directly into
// that one child's environment is not. Same reasoning
// connectStdioMcpServer's own doc comment gives for not inheriting this
// CLI's own broader environment into the spawned server.
//
// -- Read-only guarantee, and why this adapter's scope is narrower than
// Notion's --
// monday's official MCP server exposes 60+ tools, including several
// whose read/write status isn't a clean binary from the public tool
// catalog alone -- most notably all_monday_api, a raw GraphQL passthrough
// that could execute a mutation depending on the query text it's given,
// and a family of workflow/agent-builder tools with no obvious read-only
// equivalent. With no live monday.com account to test tool behavior
// against directly, this adapter deliberately scopes itself to the two
// tools whose read-only nature is unambiguous from their own names and
// documented purpose: get_board_items_page and get_updates. MONDAY_READS
// below is exhaustive -- nothing else, including search and all_monday_api,
// is ever called. Board discovery is intentionally NOT automatic for the
// same reason: the walker takes an explicit list of board ids from the
// customer (--monday-boards, repeatable) rather than guessing which boards
// to read via a tool this adapter hasn't independently confirmed is
// read-only.
//
// -- Honest limit on what's verified here --
// Like mcp-notion.ts, the exact JSON shape get_board_items_page and
// get_updates return is documented by monday's own package README, not
// confirmed against a live server -- this codebase has no monday.com
// account to test against. Parsing below is deliberately defensive --
// multiple plausible field names for each value, and the walk drops an
// item or update it can't parse rather than failing the run. This is
// flagged as a real risk in this task's PR description, not papered over;
// see mcp-monday.test.ts for what IS verified (this adapter's
// parsing/allowlist/error-handling contract against a fake client).
import { chunkText } from "./chunk.js";
import { buildProseDocument } from "./mcp-framework/document.js";
import { resolveMcpToken, runMcpInWalk } from "./mcp-framework/walker.js";
import type { McpAdapterContext, McpInAdapter, PrebrainChunk } from "./mcp-framework/types.js";
import type { McpToolClient } from "./mcp-connector.js";

const MONDAY_READS = [
  { tool: "get_board_items_page", kind: "structured", fields: ["items", "id", "name", "column_values", "text"] },
  { tool: "get_updates", kind: "structured", fields: ["text_body", "body", "text"] },
] as const;

// Same "seed a first rulebook, don't mirror the whole account" reasoning
// as mcp-notion.ts's MAX_PAGES.
const MAX_ITEMS_PER_BOARD = 50;

export class MissingMondayMcpTokenError extends Error {
  constructor() {
    super(
      "No monday.com MCP token found. Run `gnt connect monday-mcp`, pass --monday-mcp-token, " +
        "or set GNT_MONDAY_MCP_TOKEN.",
    );
    this.name = "MissingMondayMcpTokenError";
  }
}

interface MondayItem {
  id: string;
  name: string;
  columnText: string;
}

// get_board_items_page's response is expected to be a JSON object with an
// `items` array (mirrors monday's own GraphQL items_page shape); each
// item's column values are joined into one text blob per item since this
// walker cares about the item's substance, not per-column structure --
// same "content over structure" bias notion-export.ts already applies to
// a Notion page's blocks. Runs against the framework-stripped response
// (only the declared fields survive); unparseable entries are dropped.
function parseBoardItems(data: unknown): MondayItem[] {
  const list: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).items)
      ? ((data as Record<string, unknown>).items as unknown[])
      : [];

  const items: MondayItem[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const id = obj.id;
    if (typeof id !== "string" || !id) continue;
    const name = typeof obj.name === "string" ? obj.name : "Untitled item";

    const columnValues = Array.isArray(obj.column_values) ? obj.column_values : [];
    const columnText = columnValues
      .map((cv) => (cv && typeof cv === "object" && typeof (cv as Record<string, unknown>).text === "string" ? (cv as Record<string, unknown>).text : null))
      .filter((v): v is string => Boolean(v && String(v).trim()))
      .join("\n");

    items.push({ id, name, columnText });
  }
  return items;
}

// get_updates' response is expected to be a JSON array of update
// (comment) objects, text under `text_body`, `body`, or `text` depending
// on server version -- all declared in MONDAY_READS. A non-array response
// yields no update text.
function parseUpdates(data: unknown): string {
  const list = Array.isArray(data) ? data : [];
  const lines: string[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const text =
      (typeof obj.text_body === "string" && obj.text_body) ||
      (typeof obj.body === "string" && obj.body) ||
      (typeof obj.text === "string" && obj.text);
    if (text) lines.push(text);
  }
  return lines.join("\n\n");
}

function itemSourcePath(boardId: string, itemId: string): string {
  return `boards/${boardId}/items/${itemId}`;
}

async function walkItem(ctx: McpAdapterContext, boardId: string, item: MondayItem): Promise<void> {
  let updatesText = "";
  try {
    updatesText = parseUpdates(await ctx.readStructured("get_updates", { item_id: item.id }));
  } catch {
    // An item this integration can read but can't fetch updates for
    // (permissions, no updates yet) still yields its own field content.
  }

  const body = buildProseDocument(item.name, item.columnText, updatesText);
  ctx.emitDocument({ body, sourcePath: itemSourcePath(boardId, item.id) });
}

export interface MondayWalkParams {
  boardIds: string[];
}

// The adapter object the framework runs and the registry lists.
export const mondayAdapter: McpInAdapter<MondayWalkParams> = {
  id: "monday-mcp",
  walker: "mcp-monday",
  label: "monday.com",
  tokenEnvVar: "GNT_MONDAY_MCP_TOKEN",
  missingTokenError: () => new MissingMondayMcpTokenError(),
  server: (token) => ({
    label: "monday.com",
    command: "npx",
    args: ["-y", "@mondaydotcomorg/monday-api-mcp"],
    env: { MONDAY_TOKEN: token },
  }),
  reads: MONDAY_READS,
  chunker: chunkText,
  // No board id is knowable generically at this adapter's own level (see
  // this file's own header comment on why board discovery is never
  // automatic), so this static declaration has no board_id to give
  // get_board_items_page -- calling it as declared here, unmodified, would
  // fail against a real server. It exists to satisfy the McpInAdapter
  // contract (every adapter must declare a probe) and to keep
  // declarationFor/callReadOnlyTool's allowlist check meaningful, but it is
  // NOT what actually runs during `gnt connect monday-mcp`: that command
  // supplies its own `validate` override, scoped to a real board id the
  // customer enters at connect time -- see connect-monday-mcp.ts's own
  // header comment for why a static probe can't do this for a
  // board-scoped API the way Notion's/Linear's/Sentry's workspace-wide
  // probes can.
  probe: { tool: "get_board_items_page", args: { limit: 1 } },
  async walk(ctx, { boardIds }) {
    for (const boardId of boardIds) {
      const itemsData = await ctx.readStructured("get_board_items_page", {
        board_id: boardId,
        limit: MAX_ITEMS_PER_BOARD,
      });
      const items = parseBoardItems(itemsData).slice(0, MAX_ITEMS_PER_BOARD);
      for (const item of items) {
        await walkItem(ctx, boardId, item);
      }
    }
  },
};

// The exported resolve helper stays for the prebrain barrel -- delegates to
// the framework's shared precedence (explicit token, then GNT_MONDAY_MCP_TOKEN,
// then a stored token, else MissingMondayMcpTokenError).
export function resolveMondayMcpToken(explicit: string | undefined, storedToken: string | undefined): string {
  return resolveMcpToken(mondayAdapter, explicit, storedToken);
}

export interface WalkMcpMondayOptions {
  token?: string;
  storedToken?: string;
  /** Which boards to read -- required; this walker never discovers boards on its own (see this file's own doc comment). */
  boardIds: string[];
  /** Injectable seam for tests -- defaults to a real stdio connection to @mondaydotcomorg/monday-api-mcp. */
  connect?: (token: string) => Promise<McpToolClient>;
}

// Public walker: same signature commands/prebrain.ts already calls. The
// empty-boardIds short-circuit stays here, ahead of the framework runner,
// so an empty board list never resolves a token or opens a connection --
// the exact behavior the pre-framework walker had.
export function walkMcpMonday(options: WalkMcpMondayOptions): Promise<PrebrainChunk[]> {
  if (options.boardIds.length === 0) return Promise.resolve([]);
  return runMcpInWalk(mondayAdapter, {
    token: options.token,
    storedToken: options.storedToken,
    connect: options.connect,
    params: { boardIds: options.boardIds },
  });
}

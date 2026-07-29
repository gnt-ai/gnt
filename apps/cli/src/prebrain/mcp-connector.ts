// Shared MCP-client core for the two "MCP-in" walkers:
// gnt connecting OUT, as a client, to a customer's own Notion/monday.com
// MCP server to read content. This is the mirror image of apps/api's own
// MCP server (other agents call INTO that one, see test_mcp_tools.py for
// its shape) -- don't confuse the two, nothing in this file exposes
// anything, it only calls out.
//
// Everything here runs locally in this CLI process, on the customer's own
// device: connectStdioMcpServer spawns the target server as a child
// process over stdio and this process talks MCP tool calls to it
// directly. No gnt server is in this path at all -- same trust boundary
// every other prebrain walker already has (see ../../commands/prebrain.ts's
// own top-of-file doc comment), just with a live third-party process on
// the other end of the pipe instead of a filesystem read.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export class McpConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConnectorError";
  }
}

// A deliberately loose shape for a tool call's result -- just enough of
// the MCP spec's CallToolResult (content: an array of content blocks,
// isError: whether the call itself failed) for this file's own parsing,
// not the SDK's full result type. Kept this loose (rather than importing
// the SDK's own CallToolResult) so the real Client class -- whose
// callTool() return type is a wider union for backward compatibility --
// satisfies this interface structurally with no cast, and so tests can
// hand back a plain object fake (see test/prebrain/mcp-notion.test.ts)
// instead of constructing a real Client/Transport pair.
export interface McpToolResult {
  content?: unknown[];
  isError?: boolean;
}

// The minimal surface mcp-notion.ts/mcp-monday.ts actually use -- narrower
// than the SDK's real Client type on purpose, so tests can inject a plain
// object fake instead of standing up a real Client/Transport pair for
// every case.
export interface McpToolClient {
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<McpToolResult>;
  close(): Promise<void>;
}

export interface StdioMcpServerSpec {
  /** "Notion" / "monday.com" -- for error messages only, never sent anywhere. */
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * Overrides the SDK's own 60s default handshake timeout
   * (DEFAULT_REQUEST_TIMEOUT_MSEC). Needed only when the spawned process
   * itself blocks on something slower than a normal connect before it can
   * answer `initialize` -- a managed-OAuth adapter's mcp-remote child
   * (no static token, so it runs its own interactive browser login first)
   * is the one case in this codebase that does. Every other adapter omits
   * this and gets the SDK's normal fast-fail.
   */
  connectTimeoutMs?: number;
}

// Spawns the target server and completes the MCP handshake. The server
// process inherits nothing of this CLI's own credentials (loadApiKey,
// etc.) -- spec.env is passed through as the ENTIRE child environment
// (StdioClientTransport's own contract), carrying only what each
// connector explicitly builds (see mcp-notion.ts/mcp-monday.ts), which is
// deliberately just the one third-party token each needs, not a leaked
// copy of this process's own env.
export async function connectStdioMcpServer(spec: StdioMcpServerSpec): Promise<McpToolClient> {
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env });
  const client = new Client({ name: "gnt-prebrain", version: "1.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport, spec.connectTimeoutMs ? { timeout: spec.connectTimeoutMs } : undefined);
  } catch (err) {
    throw new McpConnectorError(
      `Couldn't connect to the ${spec.label} MCP server (${spec.command} ${spec.args.join(" ")}): ${describeError(err)}`,
    );
  }

  // Wrapped rather than returned directly: the real SDK Client's
  // callTool() return type is a wider union (older servers can reply with
  // a legacy `toolResult` field instead of `content`) than this file's
  // own McpToolResult -- normalizing here means every other function in
  // this module only ever has to handle one shape, and a legacy-shaped
  // reply degrades to "no content" rather than a runtime crash.
  return {
    callTool: (params) => client.callTool(params).then(normalizeToolResult),
    close: () => client.close(),
  };
}

function normalizeToolResult(result: unknown): McpToolResult {
  if (!result || typeof result !== "object") return {};
  const obj = result as Record<string, unknown>;
  return {
    content: Array.isArray(obj.content) ? obj.content : undefined,
    isError: typeof obj.isError === "boolean" ? obj.isError : undefined,
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function firstTextPart(result: McpToolResult): string | null {
  for (const part of result.content ?? []) {
    if (part && typeof part === "object" && "type" in part) {
      const block = part as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") return block.text;
    }
  }
  return null;
}

// Every read this whole task exists to guarantee funnels through here.
// `allowedTools` is a fixed allowlist of the exact tool names a given
// walker ever calls -- not a blocklist of known write tools, and not
// whatever the live server happens to advertise as "read" vs "write" --
// so a vendor renaming a tool, silently widening a "read" tool's side
// effects, or this code accidentally growing a new call site can't
// smuggle a mutation through unnoticed. Call this, never
// client.callTool directly, from mcp-notion.ts/mcp-monday.ts.
export async function callReadOnlyTool(
  client: McpToolClient,
  allowedTools: ReadonlySet<string>,
  name: string,
  args?: Record<string, unknown>,
): Promise<string> {
  if (!allowedTools.has(name)) {
    throw new McpConnectorError(`Refusing to call "${name}" -- it is not on this walker's read-only allowlist.`);
  }

  let result: McpToolResult;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (err) {
    throw new McpConnectorError(`"${name}" failed: ${describeError(err)}`);
  }

  if (result.isError) {
    throw new McpConnectorError(`"${name}" returned an error: ${firstTextPart(result) ?? "unknown error"}`);
  }

  return firstTextPart(result) ?? "";
}

// Best-effort JSON parse of a tool's text content -- MCP servers are free
// to return either a JSON-encoded payload or a plain human-readable
// string in the same text content part, and this codebase has no live
// connection to verify which shape any given tool call actually returns
// (see mcp-notion.ts/mcp-monday.ts's own doc comments on this). Returns
// null on anything that doesn't parse as JSON rather than throwing --
// callers fall back to treating the raw text as content in that case,
// never crash the walker over a shape surprise.
export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

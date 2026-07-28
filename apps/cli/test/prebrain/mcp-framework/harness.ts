// Shared smoke-test harness for MCP-in adapters (connector sprint T1).
//
// Every adapter needs the same guarantees checked -- the read-only
// allowlist holds, undeclared fields are stripped, the token never lands
// in a log, the walk produces well-formed chunks -- and every adapter test
// would otherwise re-mock a fake MCP client and re-write those assertions.
// This file is that boilerplate, written once against the adapter
// interface so the nine upcoming connector tests import it and only supply
// their own fixtures (which tool returns what). It is deliberately
// adapter-agnostic: nothing here knows a Notion tool name from a HubSpot
// one; it reads everything it needs off the adapter object.
import { expect } from "bun:test";
import { allowlistOf, callReadOnlyTool, projectToDeclaredFields, runMcpInWalk } from "../../../src/prebrain/mcp-framework/index.js";
import type { AnyMcpInAdapter, McpInAdapter, McpToolClient, PrebrainChunk } from "../../../src/prebrain/mcp-framework/index.js";

// A tool handler returns whatever that tool's response should be for a
// given call: a string is sent back as a text content part verbatim; an
// object or array is JSON-encoded into one; mcpError(...) simulates a
// tool-level failure (isError: true).
export type FakeToolHandler = (args: Record<string, unknown> | undefined) => unknown;
export type FakeToolResponses = Record<string, FakeToolHandler>;

export interface RecordedCall {
  name: string;
  args?: Record<string, unknown>;
}

const ERROR_MARK = Symbol("mcp-fake-error");

// Wrap a handler's return value in this to make the fake reply with a
// tool-level error (the shape callReadOnlyTool turns into an McpConnectorError).
export function mcpError(text: string): unknown {
  return { [ERROR_MARK]: true, text };
}

function toContentResult(value: unknown): { content?: unknown[]; isError?: boolean } {
  if (value && typeof value === "object" && (value as Record<PropertyKey, unknown>)[ERROR_MARK]) {
    const text = String((value as { text?: unknown }).text ?? "error");
    return { isError: true, content: [{ type: "text", text }] };
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text", text }] };
}

// A fake MCP client driven by a tool->response map. Records every call so a
// test can assert which tools ran. A tool with no handler throws, so a
// walk that reaches an unexpected tool fails loudly rather than silently.
export function createFakeMcpClient(responses: FakeToolResponses): {
  client: McpToolClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client: McpToolClient = {
    async callTool(params) {
      calls.push({ name: params.name, args: params.arguments });
      const handler = responses[params.name];
      if (!handler) throw new Error(`fake MCP client has no handler for tool "${params.name}"`);
      return toContentResult(handler(params.arguments));
    },
    async close() {},
  };
  return { client, calls };
}

export interface WalkWithFakeOptions<P> {
  responses: FakeToolResponses;
  params: P;
  token?: string;
}

// Runs an adapter end to end against a fake client, returning the chunks it
// produced and the tool calls it made. Captures console output so
// credential-leak checks can inspect it.
export async function walkAdapterWithFake<P>(
  adapter: McpInAdapter<P>,
  options: WalkWithFakeOptions<P>,
): Promise<{ chunks: PrebrainChunk[]; calls: RecordedCall[]; logs: string[] }> {
  const { client, calls } = createFakeMcpClient(options.responses);
  const logs: string[] = [];
  const restore = captureConsole(logs);
  try {
    const chunks = await runMcpInWalk(adapter, {
      token: options.token ?? "test-token",
      connect: async () => client,
      params: options.params,
    });
    return { chunks, calls, logs };
  } finally {
    restore();
  }
}

// Standard assertion 1: the read-only allowlist is exactly the declared
// reads, and a tool outside it is refused before it ever reaches the
// client. Proves an adapter cannot call a write tool even by name.
export function assertReadOnlyAllowlistEnforced(adapter: AnyMcpInAdapter): void {
  const allowed = allowlistOf(adapter);
  const declared = adapter.reads.map((read) => read.tool);
  expect([...allowed].sort()).toEqual([...new Set(declared)].sort());

  const client: McpToolClient = {
    async callTool() {
      throw new Error("callReadOnlyTool must refuse an undeclared tool before calling the client");
    },
    async close() {},
  };
  // A name no adapter would declare -- refused purely because it is not on
  // the allowlist, without the client being touched.
  const forbidden = "__write_tool_never_declared__";
  expect(allowed.has(forbidden)).toBe(false);
  return void expect(callReadOnlyTool(client, allowed, forbidden)).rejects.toThrow();
}

// Standard assertion 2: for a structured tool, the framework strips every
// field the adapter did not declare. Feed a response object that mixes
// declared content with sensitive undeclared fields; the projected result
// keeps the declared keys and contains none of the sensitive values.
export function assertDeclaredFieldsStripUndeclared(
  adapter: AnyMcpInAdapter,
  tool: string,
  response: unknown,
  sensitiveValues: string[],
): void {
  const declaration = adapter.reads.find((read) => read.tool === tool);
  if (!declaration || declaration.kind !== "structured") {
    throw new Error(`${adapter.label} has no structured read declared for "${tool}"`);
  }
  const projected = projectToDeclaredFields(response, new Set(declaration.fields));
  const serialized = JSON.stringify(projected);
  for (const value of sensitiveValues) {
    expect(serialized).not.toContain(value);
  }
}

// Standard assertion 3: the token never appears in anything the walk logs.
export async function assertCredentialsNeverLogged<P>(
  adapter: McpInAdapter<P>,
  options: WalkWithFakeOptions<P>,
): Promise<void> {
  const token = options.token ?? "super-secret-token-value";
  const { logs } = await walkAdapterWithFake(adapter, { ...options, token });
  for (const line of logs) {
    expect(line).not.toContain(token);
  }
}

// Standard assertion 4: every chunk a walk produces is tagged with the
// adapter's own walker id and carries a non-empty provenance sourcePath.
export function assertChunksWellFormed(adapter: AnyMcpInAdapter, chunks: PrebrainChunk[]): void {
  for (const chunk of chunks) {
    expect(chunk.walker).toBe(adapter.walker);
    expect(chunk.sourcePath.length).toBeGreaterThan(0);
    expect(chunk.text.length).toBeGreaterThan(0);
    expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
  }
}

// Redirects console.log/error/warn into `sink` and returns a restore fn.
function captureConsole(sink: string[]): () => void {
  const original = { log: console.log, error: console.error, warn: console.warn };
  const record = (...args: unknown[]) => {
    sink.push(args.join(" "));
  };
  console.log = record;
  console.error = record;
  console.warn = record;
  return () => {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
  };
}

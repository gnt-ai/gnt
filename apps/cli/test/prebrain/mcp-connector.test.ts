// Tests the shared read-only enforcement mcp-notion.ts/mcp-monday.ts both
// build on -- this is the one guarantee this whole task exists for, so it
// gets its own direct test against a fake McpToolClient rather than only
// being exercised indirectly through the two real walkers.
import { expect, test } from "bun:test";
import { callReadOnlyTool, McpConnectorError, tryParseJson } from "../../src/prebrain/mcp-connector.js";
import type { McpToolClient } from "../../src/prebrain/mcp-connector.js";

function fakeClient(overrides: Partial<McpToolClient> = {}): McpToolClient {
  return {
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    close: async () => {},
    ...overrides,
  };
}

test("refuses to call a tool that is not on the allowlist, without ever invoking the client", async () => {
  let called = false;
  const client = fakeClient({
    callTool: async () => {
      called = true;
      return { content: [] };
    },
  });

  await expect(callReadOnlyTool(client, new Set(["search"]), "delete-block")).rejects.toThrow(McpConnectorError);
  expect(called).toBe(false);
});

test("calls an allowlisted tool and returns its first text content part", async () => {
  const client = fakeClient({
    callTool: async (params) => {
      expect(params.name).toBe("search");
      return { content: [{ type: "text", text: "hello world" }] };
    },
  });

  const result = await callReadOnlyTool(client, new Set(["search"]), "search", { query: "" });
  expect(result).toBe("hello world");
});

test("surfaces a tool-level error (isError: true) as a McpConnectorError", async () => {
  const client = fakeClient({
    callTool: async () => ({ isError: true, content: [{ type: "text", text: "invalid token" }] }),
  });

  await expect(callReadOnlyTool(client, new Set(["search"]), "search")).rejects.toThrow(/invalid token/);
});

test("surfaces a transport/network failure as a McpConnectorError, not a raw throw", async () => {
  const client = fakeClient({
    callTool: async () => {
      throw new Error("ECONNRESET");
    },
  });

  await expect(callReadOnlyTool(client, new Set(["search"]), "search")).rejects.toThrow(McpConnectorError);
});

test("returns an empty string when a successful result has no text content", async () => {
  const client = fakeClient({ callTool: async () => ({ content: [{ type: "image", data: "..." }] }) });

  const result = await callReadOnlyTool(client, new Set(["search"]), "search");
  expect(result).toBe("");
});

test("tryParseJson parses a JSON object or array and returns null for plain text", () => {
  expect(tryParseJson('{"a": 1}')).toEqual({ a: 1 });
  expect(tryParseJson("[1, 2, 3]")).toEqual([1, 2, 3]);
  expect(tryParseJson("just some plain text, not json")).toBeNull();
  expect(tryParseJson("{not actually valid json")).toBeNull();
});

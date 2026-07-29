// Tests the live-monday.com walker against a fake McpToolClient. See
// mcp-notion.test.ts's own header for why -- no real network call, no
// real @mondaydotcomorg/monday-api-mcp process, ever runs in this file.
//
// framework.test.ts already runs assertReadOnlyAllowlistEnforced and an
// assertDeclaredFieldsStripUndeclared check against mondayAdapter's
// get_board_items_page tool. The shared-harness block at the bottom of
// this file adds what that coverage doesn't reach: get_updates' own field
// stripping (the tool that carries an item's updates -- the "comments"
// half of the plan's "monday reads item updates/comments only" scope) and
// assertCredentialsNeverLogged run against the real adapter rather than a
// synthetic one -- the same convention mcp-linear.test.ts/mcp-sentry.test.ts/
// mcp-granola.test.ts already establish for themselves.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { MissingMondayMcpTokenError, mondayAdapter, walkMcpMonday } from "../../src/prebrain/mcp-monday.js";
import type { McpToolClient } from "../../src/prebrain/mcp-connector.js";
import { assertCredentialsNeverLogged, assertDeclaredFieldsStripUndeclared } from "./mcp-framework/harness.js";

interface RecordedCall {
  name: string;
  args?: Record<string, unknown>;
}

let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env.GNT_MONDAY_MCP_TOKEN;
  delete process.env.GNT_MONDAY_MCP_TOKEN;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.GNT_MONDAY_MCP_TOKEN;
  else process.env.GNT_MONDAY_MCP_TOKEN = originalEnv;
});

function fakeMondayClient(
  boards: Record<string, { items: { id: string; name: string; column_values: { text: string }[] }[] }>,
  updatesByItem: Record<string, { text_body: string }[]>,
  calls: RecordedCall[],
): McpToolClient {
  return {
    async callTool(params) {
      calls.push({ name: params.name, args: params.arguments });
      if (params.name === "get_board_items_page") {
        const boardId = params.arguments?.board_id as string;
        const board = boards[boardId];
        return { content: [{ type: "text", text: JSON.stringify({ items: board?.items ?? [] }) }] };
      }
      if (params.name === "get_updates") {
        const itemId = params.arguments?.item_id as string;
        return { content: [{ type: "text", text: JSON.stringify(updatesByItem[itemId] ?? []) }] };
      }
      throw new Error(`unexpected tool call in test fake: ${params.name}`);
    },
    async close() {},
  };
}

test("walks board items into PrebrainChunks tagged mcp-monday, with boards/<id>/items/<id> as sourcePath", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeMondayClient(
    {
      "board-1": {
        items: [{ id: "item-1", name: "Refund request", column_values: [{ text: "Amount: $600" }] }],
      },
    },
    { "item-1": [{ text_body: "Approved by manager after review." }] },
    calls,
  );

  const chunks = await walkMcpMonday({ token: "t", boardIds: ["board-1"], connect: async () => client });

  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.walker).toBe("mcp-monday");
    expect(chunk.sourcePath).toBe("boards/board-1/items/item-1");
  }
  const combined = chunks.map((c) => c.text).join("\n");
  expect(combined).toContain("Amount: $600");
  expect(combined).toContain("Approved by manager after review.");
});

test("never calls a write tool -- only get_board_items_page and get_updates appear in the call log", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeMondayClient(
    { "board-1": { items: [{ id: "item-1", name: "Item", column_values: [{ text: "some text" }] }] } },
    {},
    calls,
  );

  await walkMcpMonday({ token: "t", boardIds: ["board-1"], connect: async () => client });

  const toolNames = new Set(calls.map((c) => c.name));
  for (const name of toolNames) {
    expect(["get_board_items_page", "get_updates"]).toContain(name);
  }
  expect(toolNames.has("create_item")).toBe(false);
  expect(toolNames.has("change_item_column_values")).toBe(false);
  expect(toolNames.has("all_monday_api")).toBe(false);
});

test("returns no chunks and never connects when boardIds is empty", async () => {
  let connectCalled = false;
  const connect = async () => {
    connectCalled = true;
    return fakeMondayClient({}, {}, []);
  };

  const chunks = await walkMcpMonday({ token: "t", boardIds: [], connect });
  expect(chunks).toEqual([]);
  expect(connectCalled).toBe(false);
});

test("throws MissingMondayMcpTokenError with no token from any source, and never attempts to connect", async () => {
  let connectCalled = false;
  const connect = async () => {
    connectCalled = true;
    return fakeMondayClient({}, {}, []);
  };

  await expect(walkMcpMonday({ boardIds: ["board-1"], connect })).rejects.toThrow(MissingMondayMcpTokenError);
  expect(connectCalled).toBe(false);
});

test("an item whose updates call fails still yields chunks from its own column values", async () => {
  const client: McpToolClient = {
    async callTool(params) {
      if (params.name === "get_board_items_page") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ items: [{ id: "item-1", name: "Item", column_values: [{ text: "Escalate to manager on breach." }] }] }),
            },
          ],
        };
      }
      if (params.name === "get_updates") {
        return { isError: true, content: [{ type: "text", text: "not found" }] };
      }
      throw new Error(`unexpected: ${params.name}`);
    },
    async close() {},
  };

  const chunks = await walkMcpMonday({ token: "t", boardIds: ["board-1"], connect: async () => client });
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.map((c) => c.text).join("\n")).toContain("Escalate to manager on breach.");
});

test("reads every board in boardIds, not just the first", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeMondayClient(
    {
      "board-1": { items: [{ id: "item-1", name: "I1", column_values: [{ text: "Board one content." }] }] },
      "board-2": { items: [{ id: "item-2", name: "I2", column_values: [{ text: "Board two content." }] }] },
    },
    {},
    calls,
  );

  const chunks = await walkMcpMonday({ token: "t", boardIds: ["board-1", "board-2"], connect: async () => client });

  const sourcePaths = chunks.map((c) => c.sourcePath);
  expect(sourcePaths).toContain("boards/board-1/items/item-1");
  expect(sourcePaths).toContain("boards/board-2/items/item-2");
});

// ---- shared harness assertions (framework README checklist) ----
//
// Real gap this closes: framework.test.ts's own "monday board items strip
// an undeclared record field" test only exercises get_board_items_page --
// get_updates, the tool that actually carries an update's (comment's) own
// text, has never had its own field projection proven anywhere, even
// though it's the more sensitive of the two tools per-item (an update can
// carry an author's identity the same way a board item can carry an
// assignee's).

test("harness: get_updates strips undeclared record fields (an update author's identity)", () => {
  assertDeclaredFieldsStripUndeclared(
    mondayAdapter,
    "get_updates",
    [{ text_body: "Approved by manager after review.", creator: { id: "u1", email: "leak@x.com", name: "Leaker" } }],
    ["leak@x.com", "Leaker"],
  );
});

test("harness: the token never appears in anything the walk logs", async () => {
  await assertCredentialsNeverLogged(mondayAdapter, {
    responses: {
      get_board_items_page: () => ({ items: [{ id: "item-1", name: "Item", column_values: [{ text: "some text" }] }] }),
      get_updates: () => [],
    },
    params: { boardIds: ["board-1"] },
    token: "secret_monday_token_never_logged",
  });
});

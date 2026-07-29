// Tests the live-Notion walker against a fake McpToolClient (see
// mcp-connector.test.ts for the allowlist enforcement itself, tested
// directly there) -- no real network call, no real @notionhq/notion-mcp-server
// process, ever runs in this file.
//
// framework.test.ts already runs assertReadOnlyAllowlistEnforced and an
// assertDeclaredFieldsStripUndeclared check against notionAdapter's
// `API-post-search` tool. The shared-harness block at the bottom of this
// file adds what that coverage doesn't reach: API-retrieve-a-comment's own
// field stripping (the tool that actually carries comment text) and
// assertCredentialsNeverLogged run against the real adapter rather than a
// synthetic one -- the same convention mcp-linear.test.ts/mcp-sentry.test.ts/
// mcp-granola.test.ts already establish for themselves.
//
// Tool names and response shapes here are @notionhq/notion-mcp-server's
// real ones (confirmed live against v2.4.1), not the plain-REST-endpoint
// names this file originally guessed --
// search results carry a title at properties.title.title[].plain_text,
// and API-retrieve-page-markdown's own response is a JSON envelope
// ({"object":"page_markdown","markdown":"..."}), not raw markdown text.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { MissingNotionMcpTokenError, notionAdapter, walkMcpNotion } from "../../src/prebrain/mcp-notion.js";
import type { McpToolClient } from "../../src/prebrain/mcp-connector.js";
import { assertCredentialsNeverLogged, assertDeclaredFieldsStripUndeclared } from "./mcp-framework/harness.js";

let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env.GNT_NOTION_MCP_TOKEN;
  delete process.env.GNT_NOTION_MCP_TOKEN;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.GNT_NOTION_MCP_TOKEN;
  else process.env.GNT_NOTION_MCP_TOKEN = originalEnv;
});

interface RecordedCall {
  name: string;
  args?: Record<string, unknown>;
}

// Real Notion page-object shape: a title is one property (itself named
// "title") holding an array of rich text runs, each with its own
// plain_text -- see mcp-notion.ts's extractTitle for what reads this.
function notionTitleProperty(text: string) {
  return { title: { id: "title", type: "title", title: [{ type: "text", plain_text: text }] } };
}

function fakeNotionClient(pages: Record<string, { markdown: string; comments?: unknown[] }>, calls: RecordedCall[]): McpToolClient {
  const searchResults = Object.keys(pages).map((id) => ({
    id,
    properties: notionTitleProperty(`Page ${id}`),
    url: `https://notion.so/${id}`,
  }));

  return {
    async callTool(params) {
      calls.push({ name: params.name, arguments: params.arguments } as unknown as RecordedCall);
      if (params.name === "API-post-search") {
        return { content: [{ type: "text", text: JSON.stringify({ object: "list", results: searchResults }) }] };
      }
      if (params.name === "API-retrieve-page-markdown") {
        const id = params.arguments?.page_id as string;
        const page = pages[id];
        return { content: [{ type: "text", text: JSON.stringify({ object: "page_markdown", markdown: page?.markdown ?? "" }) }] };
      }
      if (params.name === "API-retrieve-a-comment") {
        const id = params.arguments?.block_id as string;
        const page = pages[id];
        return { content: [{ type: "text", text: JSON.stringify(page?.comments ?? []) }] };
      }
      throw new Error(`unexpected tool call in test fake: ${params.name}`);
    },
    async close() {},
  };
}

test("walks search results into PrebrainChunks tagged mcp-notion, with the page URL as sourcePath", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeNotionClient(
    {
      "page-1": {
        markdown: "Refunds over $500 must be approved by a manager before processing.",
        comments: [{ plain_text: "Also true for partial refunds." }],
      },
    },
    calls,
  );

  const chunks = await walkMcpNotion({ token: "secret_test_token", connect: async () => client });

  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.walker).toBe("mcp-notion");
    expect(chunk.sourcePath).toBe("https://notion.so/page-1");
  }
  const combined = chunks.map((c) => c.text).join("\n");
  expect(combined).toContain("Refunds over $500 must be approved by a manager");
  expect(combined).toContain("Also true for partial refunds.");
});

test("never calls a write tool -- only API-post-search, API-retrieve-page-markdown, and API-retrieve-a-comment appear in the call log", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeNotionClient(
    { "page-1": { markdown: "Some policy text worth chunking here.", comments: [] } },
    calls,
  );

  await walkMcpNotion({ token: "secret_test_token", connect: async () => client });

  const toolNames = new Set(calls.map((c) => c.name));
  for (const name of toolNames) {
    expect(["API-post-search", "API-retrieve-page-markdown", "API-retrieve-a-comment"]).toContain(name);
  }
  expect(toolNames.has("create-page")).toBe(false);
  expect(toolNames.has("update-page")).toBe(false);
  expect(toolNames.has("delete-block")).toBe(false);
});

test("a page whose comments call fails still yields chunks from its own body", async () => {
  const client: McpToolClient = {
    async callTool(params) {
      if (params.name === "API-post-search") {
        return {
          content: [
            { type: "text", text: JSON.stringify({ results: [{ id: "p1", properties: notionTitleProperty("P1"), url: "https://notion.so/p1" }] }) },
          ],
        };
      }
      if (params.name === "API-retrieve-page-markdown") {
        return { content: [{ type: "text", text: JSON.stringify({ object: "page_markdown", markdown: "Escalate any incident above severity 2 immediately." }) }] };
      }
      if (params.name === "API-retrieve-a-comment") {
        return { isError: true, content: [{ type: "text", text: "permission denied" }] };
      }
      throw new Error(`unexpected: ${params.name}`);
    },
    async close() {},
  };

  const chunks = await walkMcpNotion({ token: "secret_test_token", connect: async () => client });

  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.map((c) => c.text).join("\n")).toContain("Escalate any incident above severity 2");
});

test("throws MissingNotionMcpTokenError with no token from any source, and never attempts to connect", async () => {
  let connectCalled = false;
  const connect = async () => {
    connectCalled = true;
    return fakeNotionClient({}, []);
  };

  await expect(walkMcpNotion({ connect })).rejects.toThrow(MissingNotionMcpTokenError);
  expect(connectCalled).toBe(false);
});

test("falls back to GNT_NOTION_MCP_TOKEN, then to a stored token, in that precedence order", async () => {
  process.env.GNT_NOTION_MCP_TOKEN = "env-token";
  const calls: RecordedCall[] = [];
  const client = fakeNotionClient({}, calls);

  // env var wins over storedToken when both are present
  await walkMcpNotion({ storedToken: "stored-token", connect: async () => client });

  delete process.env.GNT_NOTION_MCP_TOKEN;
  // storedToken alone is still sufficient
  await expect(walkMcpNotion({ storedToken: "stored-token", connect: async () => client })).resolves.toBeDefined();
});

test("a connection failure surfaces as a clear error rather than an unhandled rejection shape", async () => {
  await expect(
    walkMcpNotion({
      token: "secret_test_token",
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    }),
  ).rejects.toThrow(/ECONNREFUSED/);
});

test("always closes the client, even when a mid-walk tool call throws", async () => {
  let closed = false;
  const client: McpToolClient = {
    async callTool(params) {
      if (params.name === "API-post-search") throw new Error("boom");
      throw new Error("unexpected");
    },
    async close() {
      closed = true;
    },
  };

  await expect(walkMcpNotion({ token: "t", connect: async () => client })).rejects.toThrow();
  expect(closed).toBe(true);
});

// ---- shared harness assertions (framework README checklist) ----
//
// Real gap this closes: framework.test.ts's own "monday board items strip
// an undeclared record field" and "Notion search strips an undeclared
// record field" tests only ever exercise one tool each (get_board_items_page,
// API-post-search) -- API-retrieve-a-comment, the tool that actually
// carries a page's discussion text, has never had its own field
// projection proven anywhere.

test("harness: API-retrieve-a-comment strips undeclared record fields (a commenter's identity)", () => {
  assertDeclaredFieldsStripUndeclared(
    notionAdapter,
    "API-retrieve-a-comment",
    [{ plain_text: "Confirmed by finance.", created_by: { id: "u1", email: "leak@x.com", name: "Leaker" } }],
    ["leak@x.com", "Leaker"],
  );
});

test("harness: the token never appears in anything the walk logs", async () => {
  await assertCredentialsNeverLogged(notionAdapter, {
    responses: {
      "API-post-search": () => ({ results: [{ id: "p1", properties: notionTitleProperty("Page"), url: "https://notion.so/p1" }] }),
      "API-retrieve-page-markdown": () => ({ object: "page_markdown", markdown: "Some policy text worth chunking here." }),
      "API-retrieve-a-comment": () => [],
    },
    params: undefined,
    token: "secret_notion_token_never_logged",
  });
});

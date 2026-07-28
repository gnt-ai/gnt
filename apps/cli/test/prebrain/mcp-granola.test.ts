// Tests the live-Granola walker against the shared harness plus a fake
// McpToolClient. No real network call, no real mcp-remote process, ever
// runs in this file -- see mcp-notion.test.ts's own header for why.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { granolaAdapter, MissingGranolaMcpTokenError, walkMcpGranola } from "../../src/prebrain/mcp-granola.js";
import type { McpToolClient } from "../../src/prebrain/mcp-connector.js";
import {
  assertChunksWellFormed,
  assertCredentialsNeverLogged,
  assertDeclaredFieldsStripUndeclared,
  assertReadOnlyAllowlistEnforced,
  walkAdapterWithFake,
} from "./mcp-framework/harness.js";

let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env.GNT_GRANOLA_MCP_TOKEN;
  delete process.env.GNT_GRANOLA_MCP_TOKEN;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.GNT_GRANOLA_MCP_TOKEN;
  else process.env.GNT_GRANOLA_MCP_TOKEN = originalEnv;
});

test("only calls read-only tools on the allowlist", () => {
  assertReadOnlyAllowlistEnforced(granolaAdapter);
});

test("never declares get_account_info or query_granola_meetings -- account metadata and unscoped cross-folder search are out of scope", () => {
  const declaredTools = granolaAdapter.reads.map((r) => r.tool);
  expect(declaredTools).not.toContain("get_account_info");
  expect(declaredTools).not.toContain("query_granola_meetings");
  expect(declaredTools.sort()).toEqual(["get_meeting_transcript", "get_meetings", "list_meeting_folders", "list_meetings"]);
});

test("strips undeclared record fields (attendees) from a get_meetings read", () => {
  assertDeclaredFieldsStripUndeclared(
    granolaAdapter,
    "get_meetings",
    {
      meetings: [
        {
          id: "m1",
          title: "Keep",
          notes: "Keep this",
          attendees: [{ email: "leak@acme.com", name: "Leaky Attendee" }],
        },
      ],
    },
    ["leak@acme.com", "Leaky Attendee"],
  );
});

test("never logs the token", async () => {
  await assertCredentialsNeverLogged(granolaAdapter, {
    responses: {
      list_meetings: () => ({ meetings: [] }),
    },
    params: { folderIds: ["folder-1"] },
    token: "secret-granola-token",
  });
});

test("walks a folder's meetings into well-formed chunks, tagged mcp-granola", async () => {
  const { chunks } = await walkAdapterWithFake(granolaAdapter, {
    responses: {
      list_meetings: () => ({ meetings: [{ id: "m1", title: "Roadmap sync", url: "https://notes.granola.ai/d/m1" }] }),
      get_meetings: () => ({ meetings: [{ id: "m1", notes: "Shipping the vendor migration in Q3." }] }),
      get_meeting_transcript: () =>
        "Jane Doe: We're going to go with the vendor migration in Q3.\n\nJohn Smith: Sounds good, I'll update the roadmap doc.",
    },
    params: { folderIds: ["folder-1"] },
  });

  assertChunksWellFormed(granolaAdapter, chunks);
  for (const chunk of chunks) {
    expect(chunk.walker).toBe("mcp-granola");
    expect(chunk.sourcePath).toBe("https://notes.granola.ai/d/m1");
  }
  const combined = chunks.map((c) => c.text).join("\n");
  expect(combined).toContain("vendor migration in Q3");
});

test("falls back to a stable meetings/<id> sourcePath when the vendor gives no url", async () => {
  const { chunks } = await walkAdapterWithFake(granolaAdapter, {
    responses: {
      list_meetings: () => ({ meetings: [{ id: "m2", title: "No link meeting" }] }),
      get_meetings: () => ({ meetings: [{ id: "m2", notes: "Some notes." }] }),
      get_meeting_transcript: () => "",
    },
    params: { folderIds: ["folder-1"] },
  });

  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.sourcePath).toBe("meetings/m2");
  }
});

test("a meeting whose transcript read fails still yields chunks from its own notes", async () => {
  const client: McpToolClient = {
    async callTool(params) {
      if (params.name === "list_meetings") {
        return { content: [{ type: "text", text: JSON.stringify({ meetings: [{ id: "m3", title: "Free-tier meeting" }] }) }] };
      }
      if (params.name === "get_meetings") {
        return {
          content: [
            { type: "text", text: JSON.stringify({ meetings: [{ id: "m3", notes: "We've decided to escalate this." }] }) },
          ],
        };
      }
      if (params.name === "get_meeting_transcript") {
        return { isError: true, content: [{ type: "text", text: "transcript requires a paid plan" }] };
      }
      throw new Error(`unexpected tool call in test fake: ${params.name}`);
    },
    async close() {},
  };

  const chunks = await walkMcpGranola({ token: "t", folderIds: ["folder-1"], connect: async () => client });
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.map((c) => c.text).join("\n")).toContain("escalate this");
});

test("a folder whose get_meetings batch fails still yields chunks from each meeting's own transcript", async () => {
  const client: McpToolClient = {
    async callTool(params) {
      if (params.name === "list_meetings") {
        return { content: [{ type: "text", text: JSON.stringify({ meetings: [{ id: "m4", title: "No notes access" }] }) }] };
      }
      if (params.name === "get_meetings") {
        return { isError: true, content: [{ type: "text", text: "not found" }] };
      }
      if (params.name === "get_meeting_transcript") {
        return { content: [{ type: "text", text: "Jane Doe: Let's go with the plan as written." }] };
      }
      throw new Error(`unexpected: ${params.name}`);
    },
    async close() {},
  };

  const chunks = await walkMcpGranola({ token: "t", folderIds: ["folder-1"], connect: async () => client });
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.map((c) => c.text).join("\n")).toContain("Let's go with the plan as written.");
});

test("batches get_meetings calls in groups of 10 meeting ids", async () => {
  const calls: Record<string, unknown>[] = [];
  const meetings = Array.from({ length: 15 }, (_, i) => ({ id: `m${i}`, title: `Meeting ${i}` }));

  const client: McpToolClient = {
    async callTool(params) {
      calls.push({ name: params.name, args: params.arguments });
      if (params.name === "list_meetings") {
        return { content: [{ type: "text", text: JSON.stringify({ meetings }) }] };
      }
      if (params.name === "get_meetings") {
        return { content: [{ type: "text", text: JSON.stringify({ meetings: [] }) }] };
      }
      if (params.name === "get_meeting_transcript") {
        return { content: [{ type: "text", text: "" }] };
      }
      throw new Error(`unexpected: ${params.name}`);
    },
    async close() {},
  };

  await walkMcpGranola({ token: "t", folderIds: ["folder-1"], connect: async () => client });

  const getMeetingsCalls = calls.filter((c) => c.name === "get_meetings");
  expect(getMeetingsCalls).toHaveLength(2);
  expect((getMeetingsCalls[0].args as { meeting_ids: string[] }).meeting_ids).toHaveLength(10);
  expect((getMeetingsCalls[1].args as { meeting_ids: string[] }).meeting_ids).toHaveLength(5);
});

test("reads every folder in folderIds, not just the first", async () => {
  const client: McpToolClient = {
    async callTool(params) {
      const folderId = (params.arguments as { folder_id?: string } | undefined)?.folder_id;
      if (params.name === "list_meetings") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ meetings: [{ id: `${folderId}-meeting`, title: `${folderId} meeting` }] }),
            },
          ],
        };
      }
      if (params.name === "get_meetings") {
        return { content: [{ type: "text", text: JSON.stringify({ meetings: [] }) }] };
      }
      if (params.name === "get_meeting_transcript") {
        return { content: [{ type: "text", text: `Content from ${folderId}.` }] };
      }
      throw new Error(`unexpected: ${params.name}`);
    },
    async close() {},
  };

  const chunks = await walkMcpGranola({ token: "t", folderIds: ["folder-a", "folder-b"], connect: async () => client });
  const sourcePaths = chunks.map((c) => c.sourcePath);
  expect(sourcePaths).toContain("meetings/folder-a-meeting");
  expect(sourcePaths).toContain("meetings/folder-b-meeting");
});

test("returns no chunks and never connects when folderIds is empty", async () => {
  let connectCalled = false;
  const connect = async () => {
    connectCalled = true;
    return { async callTool() { throw new Error("should not be called"); }, async close() {} };
  };

  const chunks = await walkMcpGranola({ token: "t", folderIds: [], connect });
  expect(chunks).toEqual([]);
  expect(connectCalled).toBe(false);
});

test("throws MissingGranolaMcpTokenError with no token from any source, and never attempts to connect", async () => {
  let connectCalled = false;
  const connect = async () => {
    connectCalled = true;
    return { async callTool() { throw new Error("should not be called"); }, async close() {} };
  };

  await expect(walkMcpGranola({ folderIds: ["folder-1"], connect })).rejects.toThrow(MissingGranolaMcpTokenError);
  expect(connectCalled).toBe(false);
});

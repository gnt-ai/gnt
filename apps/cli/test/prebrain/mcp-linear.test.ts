// Tests the live-Linear walker against a fake McpToolClient. See
// mcp-notion.test.ts's own header for why -- no real network call, no real
// mcp-remote/Linear MCP process, ever runs in this file. The shared-harness
// assertions (allowlist, field stripping, credential logging, well-formed
// chunks) run here too, per the framework README's own checklist, rather
// than being folded into framework.test.ts, which is scoped to the
// synthetic adapter plus the real Notion/monday adapters.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { MissingLinearMcpTokenError, linearAdapter, walkMcpLinear } from "../../src/prebrain/mcp-linear.js";
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
  originalEnv = process.env.GNT_LINEAR_MCP_TOKEN;
  delete process.env.GNT_LINEAR_MCP_TOKEN;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.GNT_LINEAR_MCP_TOKEN;
  else process.env.GNT_LINEAR_MCP_TOKEN = originalEnv;
});

interface RecordedCall {
  name: string;
  args?: Record<string, unknown>;
}

interface FakeIssue {
  id: string;
  title: string;
  url?: string;
}

interface FakeDocument {
  id: string;
  title: string;
  url?: string;
}

interface FakeLinearFixture {
  issuesByTeam?: Record<string, FakeIssue[]>;
  issuesByProject?: Record<string, FakeIssue[]>;
  descriptions?: Record<string, string>;
  comments?: Record<string, unknown[] | { isError: true }>;
  documentsByProject?: Record<string, FakeDocument[]>;
  contents?: Record<string, string>;
}

function fakeLinearClient(fixture: FakeLinearFixture, calls: RecordedCall[]): McpToolClient {
  return {
    async callTool(params) {
      calls.push({ name: params.name, args: params.arguments });
      const args = params.arguments ?? {};

      if (params.name === "list_issues") {
        // "team"/"project", not "teamId"/"projectId" -- confirmed live
        // against the real hosted server, see mcp-linear.ts's own walk()
        // comment for why the call site translates to these names.
        const team = args.team as string | undefined;
        const project = args.project as string | undefined;
        const issues = team
          ? (fixture.issuesByTeam?.[team] ?? [])
          : project
            ? (fixture.issuesByProject?.[project] ?? [])
            : [];
        return { content: [{ type: "text", text: JSON.stringify({ issues }) }] };
      }
      if (params.name === "get_issue") {
        const id = args.id as string;
        return { content: [{ type: "text", text: JSON.stringify({ id, description: fixture.descriptions?.[id] ?? "" }) }] };
      }
      if (params.name === "list_comments") {
        const issueId = args.issueId as string;
        const entry = fixture.comments?.[issueId] ?? [];
        if (entry && typeof entry === "object" && !Array.isArray(entry) && "isError" in entry) {
          return { isError: true, content: [{ type: "text", text: "permission denied" }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ comments: entry }) }] };
      }
      if (params.name === "list_documents") {
        const projectId = args.projectId as string;
        return { content: [{ type: "text", text: JSON.stringify({ documents: fixture.documentsByProject?.[projectId] ?? [] }) }] };
      }
      if (params.name === "get_document") {
        const id = args.id as string;
        return { content: [{ type: "text", text: JSON.stringify({ id, content: fixture.contents?.[id] ?? "" }) }] };
      }
      if (params.name === "list_teams") {
        return { content: [{ type: "text", text: JSON.stringify({ teams: [] }) }] };
      }
      throw new Error(`unexpected tool call in test fake: ${params.name}`);
    },
    async close() {},
  };
}

test("walks issues in team scope into PrebrainChunks tagged mcp-linear, with the issue URL as sourcePath", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeLinearClient(
    {
      issuesByTeam: { "team-1": [{ id: "issue-1", title: "Refund policy", url: "https://linear.app/acme/issue/ENG-1" }] },
      descriptions: { "issue-1": "Refunds over $500 require manager approval." },
      comments: { "issue-1": [{ body: "Confirmed by finance." }] },
    },
    calls,
  );

  const chunks = await walkMcpLinear({ token: "t", teamIds: ["team-1"], projectIds: [], connect: async () => client });

  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.walker).toBe("mcp-linear");
    expect(chunk.sourcePath).toBe("https://linear.app/acme/issue/ENG-1");
  }
  const combined = chunks.map((c) => c.text).join("\n");
  expect(combined).toContain("Refunds over $500 require manager approval");
  expect(combined).toContain("Confirmed by finance.");
});

test("an issue missing a URL falls back to issues/<id> as sourcePath", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeLinearClient(
    {
      issuesByTeam: { "team-1": [{ id: "issue-9", title: "No link" }] },
      descriptions: { "issue-9": "Some decision text worth chunking here." },
    },
    calls,
  );

  const chunks = await walkMcpLinear({ token: "t", teamIds: ["team-1"], projectIds: [], connect: async () => client });
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.every((c) => c.sourcePath === "issues/issue-9")).toBe(true);
});

test("walks issues and documents in project scope, with the document URL as sourcePath", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeLinearClient(
    {
      issuesByProject: { "proj-1": [{ id: "issue-2", title: "Escalation", url: "https://linear.app/acme/issue/ENG-2" }] },
      descriptions: { "issue-2": "Escalate any severity-1 incident within 15 minutes." },
      documentsByProject: { "proj-1": [{ id: "doc-1", title: "Runbook", url: "https://linear.app/acme/document/runbook" }] },
      contents: { "doc-1": "On-call rotates weekly; page the secondary if the primary misses a page." },
    },
    calls,
  );

  const chunks = await walkMcpLinear({ token: "t", teamIds: [], projectIds: ["proj-1"], connect: async () => client });

  const sourcePaths = chunks.map((c) => c.sourcePath);
  expect(sourcePaths).toContain("https://linear.app/acme/issue/ENG-2");
  expect(sourcePaths).toContain("https://linear.app/acme/document/runbook");
  const combined = chunks.map((c) => c.text).join("\n");
  expect(combined).toContain("Escalate any severity-1 incident");
  expect(combined).toContain("page the secondary");
});

test("never calls a write tool -- only the declared read tools appear in the call log", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeLinearClient(
    {
      issuesByTeam: { "team-1": [{ id: "issue-1", title: "Item" }] },
      descriptions: { "issue-1": "Some policy text worth chunking here." },
    },
    calls,
  );

  await walkMcpLinear({ token: "t", teamIds: ["team-1"], projectIds: [], connect: async () => client });

  const toolNames = new Set(calls.map((c) => c.name));
  for (const name of toolNames) {
    expect(["list_issues", "get_issue", "list_comments", "list_documents", "get_document", "list_teams"]).toContain(name);
  }
  expect(toolNames.has("create_issue")).toBe(false);
  expect(toolNames.has("update_issue")).toBe(false);
  expect(toolNames.has("create_comment")).toBe(false);
});

test("an issue whose comments call fails still yields a chunk from its own description", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeLinearClient(
    {
      issuesByTeam: { "team-1": [{ id: "issue-1", title: "Item", url: "https://linear.app/acme/issue/ENG-1" }] },
      descriptions: { "issue-1": "Escalate any incident above severity 2 immediately." },
      comments: { "issue-1": { isError: true } },
    },
    calls,
  );

  const chunks = await walkMcpLinear({ token: "t", teamIds: ["team-1"], projectIds: [], connect: async () => client });
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.map((c) => c.text).join("\n")).toContain("Escalate any incident above severity 2");
});

test("a project whose list_documents call fails still yields its own issues", async () => {
  const client: McpToolClient = {
    async callTool(params) {
      if (params.name === "list_issues") {
        return { content: [{ type: "text", text: JSON.stringify({ issues: [{ id: "issue-1", title: "Item" }] }) }] };
      }
      if (params.name === "get_issue") {
        return { content: [{ type: "text", text: JSON.stringify({ description: "Keep this decision text." }) }] };
      }
      if (params.name === "list_comments") {
        return { content: [{ type: "text", text: JSON.stringify({ comments: [] }) }] };
      }
      if (params.name === "list_documents") {
        return { isError: true, content: [{ type: "text", text: "not found" }] };
      }
      throw new Error(`unexpected: ${params.name}`);
    },
    async close() {},
  };

  const chunks = await walkMcpLinear({ token: "t", teamIds: [], projectIds: ["proj-1"], connect: async () => client });
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.map((c) => c.text).join("\n")).toContain("Keep this decision text.");
});

test("returns no chunks and never connects when both teamIds and projectIds are empty", async () => {
  let connectCalled = false;
  const connect = async () => {
    connectCalled = true;
    return fakeLinearClient({}, []);
  };

  const chunks = await walkMcpLinear({ token: "t", teamIds: [], projectIds: [], connect });
  expect(chunks).toEqual([]);
  expect(connectCalled).toBe(false);
});

test("throws MissingLinearMcpTokenError with no token from any source, and never attempts to connect", async () => {
  let connectCalled = false;
  const connect = async () => {
    connectCalled = true;
    return fakeLinearClient({}, []);
  };

  await expect(walkMcpLinear({ teamIds: ["team-1"], projectIds: [], connect })).rejects.toThrow(MissingLinearMcpTokenError);
  expect(connectCalled).toBe(false);
});

test("falls back to GNT_LINEAR_MCP_TOKEN, then to a stored token, in that precedence order", async () => {
  process.env.GNT_LINEAR_MCP_TOKEN = "env-token";
  const calls: RecordedCall[] = [];
  const client = fakeLinearClient({}, calls);

  // env var wins over storedToken when both are present
  await walkMcpLinear({ storedToken: "stored-token", teamIds: [], projectIds: ["proj-1"], connect: async () => client });

  delete process.env.GNT_LINEAR_MCP_TOKEN;
  // storedToken alone is still sufficient
  await expect(
    walkMcpLinear({ storedToken: "stored-token", teamIds: [], projectIds: ["proj-1"], connect: async () => client }),
  ).resolves.toBeDefined();
});

test("reads every team and project given, not just the first", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeLinearClient(
    {
      issuesByTeam: { "team-1": [{ id: "issue-1", title: "I1" }], "team-2": [{ id: "issue-2", title: "I2" }] },
      descriptions: { "issue-1": "Team one content.", "issue-2": "Team two content." },
    },
    calls,
  );

  const chunks = await walkMcpLinear({ token: "t", teamIds: ["team-1", "team-2"], projectIds: [], connect: async () => client });

  const sourcePaths = chunks.map((c) => c.sourcePath);
  expect(sourcePaths).toContain("issues/issue-1");
  expect(sourcePaths).toContain("issues/issue-2");
});

test("a connection failure surfaces as a clear error rather than an unhandled rejection shape", async () => {
  await expect(
    walkMcpLinear({
      token: "t",
      teamIds: ["team-1"],
      projectIds: [],
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
      if (params.name === "list_issues") throw new Error("boom");
      throw new Error("unexpected");
    },
    async close() {
      closed = true;
    },
  };

  await expect(walkMcpLinear({ token: "t", teamIds: ["team-1"], projectIds: [], connect: async () => client })).rejects.toThrow();
  expect(closed).toBe(true);
});

// ---- shared harness assertions (framework README checklist) ----

test("harness: the read-only allowlist is exactly the declared reads", () => {
  assertReadOnlyAllowlistEnforced(linearAdapter);
});

test("harness: list_issues strips undeclared record fields (assignee, workspace billing)", () => {
  assertDeclaredFieldsStripUndeclared(
    linearAdapter,
    "list_issues",
    {
      issues: [
        {
          id: "1",
          title: "Keep",
          url: "https://linear.app/acme/issue/ENG-1",
          assignee: { name: "A. Gent", email: "leak@x.com" },
          team: { id: "t1", billingEmail: "billing@acme.com" },
        },
      ],
    },
    ["leak@x.com", "billing@acme.com"],
  );
});

test("harness: get_issue strips undeclared record fields (assignee's full profile)", () => {
  assertDeclaredFieldsStripUndeclared(
    linearAdapter,
    "get_issue",
    {
      id: "1",
      title: "Keep",
      description: "Refund text.",
      assignee: { id: "u1", email: "leak@x.com", name: "A. Gent" },
    },
    ["leak@x.com"],
  );
});

test("harness: list_comments strips a comment author's profile", () => {
  assertDeclaredFieldsStripUndeclared(
    linearAdapter,
    "list_comments",
    { comments: [{ body: "Confirmed.", user: { email: "leak@x.com" } }] },
    ["leak@x.com"],
  );
});

test("harness: the token never appears in anything the walk logs", async () => {
  await assertCredentialsNeverLogged(linearAdapter, {
    responses: {
      list_issues: () => ({ issues: [] }),
    },
    params: { teamIds: ["team-1"], projectIds: [] },
    token: "super-secret-linear-token",
  });
});

test("harness: walks fixtures into well-formed chunks", async () => {
  const { chunks } = await walkAdapterWithFake(linearAdapter, {
    responses: {
      list_issues: () => ({ issues: [{ id: "1", title: "Refund policy", url: "https://linear.app/acme/issue/ENG-1" }] }),
      get_issue: () => ({ id: "1", description: "Refunds over $500 require manager approval." }),
      list_comments: () => ({ comments: [{ body: "Confirmed by finance." }] }),
    },
    params: { teamIds: ["team-1"], projectIds: [] },
  });
  assertChunksWellFormed(linearAdapter, chunks);
  expect(chunks.map((c) => c.text).join("\n")).toContain("manager approval");
});

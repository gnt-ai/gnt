// Tests the live-Jira walker against a fake McpToolClient. See
// mcp-linear.test.ts's own header for why -- no real network call, no real
// mcp-remote/Atlassian MCP process, ever runs in this file. The
// shared-harness assertions (allowlist, field stripping, credential
// logging, well-formed chunks) run here too, per the framework README's
// own checklist.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { MissingJiraMcpTokenError, jiraAdapter, walkMcpJira } from "../../src/prebrain/mcp-jira.js";
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
  originalEnv = process.env.GNT_JIRA_MCP_TOKEN;
  delete process.env.GNT_JIRA_MCP_TOKEN;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.GNT_JIRA_MCP_TOKEN;
  else process.env.GNT_JIRA_MCP_TOKEN = originalEnv;
});

interface RecordedCall {
  name: string;
  args?: Record<string, unknown>;
}

interface FakeIssueListing {
  key: string;
  fields?: { summary?: string };
}

interface FakeJiraFixture {
  issuesByProject?: Record<string, FakeIssueListing[]>;
  // Keyed by issue key; a raw getJiraIssue response, or "error" to simulate
  // a tool-level failure.
  issueDetails?: Record<string, unknown | { error: true }>;
}

function isErrorMarker(value: unknown): value is { error: true } {
  return !!value && typeof value === "object" && (value as Record<string, unknown>).error === true;
}

function fakeJiraClient(fixture: FakeJiraFixture, calls: RecordedCall[]): McpToolClient {
  return {
    async callTool(params) {
      calls.push({ name: params.name, args: params.arguments });
      const args = params.arguments ?? {};

      if (params.name === "searchJiraIssuesUsingJql") {
        const jql = String(args.jql ?? "");
        const match = /project = "([^"]+)"/.exec(jql);
        const projectKey = match?.[1] ?? "";
        const issues = fixture.issuesByProject?.[projectKey] ?? [];
        return { content: [{ type: "text", text: JSON.stringify({ issues }) }] };
      }
      if (params.name === "getJiraIssue") {
        const key = args.issueIdOrKey as string;
        const detail = fixture.issueDetails?.[key];
        if (isErrorMarker(detail)) {
          return { isError: true, content: [{ type: "text", text: "permission denied" }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(detail ?? {}) }] };
      }
      if (params.name === "getAccessibleAtlassianResources") {
        return { content: [{ type: "text", text: JSON.stringify([]) }] };
      }
      throw new Error(`unexpected tool call in test fake: ${params.name}`);
    },
    async close() {},
  };
}

test("walks issues in project scope into PrebrainChunks tagged mcp-jira, with a browse URL built from a site-URL cloud id", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeJiraClient(
    {
      issuesByProject: { ENG: [{ key: "ENG-1", fields: { summary: "Refund policy" } }] },
      issueDetails: {
        "ENG-1": {
          fields: {
            summary: "Refund policy",
            description: "Refunds over $500 require manager approval.",
            comment: { comments: [{ body: "Confirmed by finance." }] },
          },
        },
      },
    },
    calls,
  );

  const chunks = await walkMcpJira({
    token: "t",
    cloudId: "https://acme.atlassian.net",
    projectKeys: ["ENG"],
    connect: async () => client,
  });

  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.walker).toBe("mcp-jira");
    expect(chunk.sourcePath).toBe("https://acme.atlassian.net/browse/ENG-1");
  }
  const combined = chunks.map((c) => c.text).join("\n");
  expect(combined).toContain("Refunds over $500 require manager approval");
  expect(combined).toContain("Confirmed by finance.");
});

test("a raw cloud id (not a site URL) with no vendor url field falls back to jira/<cloud-id>/<key>", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeJiraClient(
    {
      issuesByProject: { ENG: [{ key: "ENG-2" }] },
      issueDetails: { "ENG-2": { fields: { description: "Some decision text worth chunking here." } } },
    },
    calls,
  );

  const chunks = await walkMcpJira({
    token: "t",
    cloudId: "11111111-2222-3333-4444-555555555555",
    projectKeys: ["ENG"],
    connect: async () => client,
  });
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.every((c) => c.sourcePath === "jira/11111111-2222-3333-4444-555555555555/ENG-2")).toBe(true);
});

test("a vendor-returned url field is used as the deep link when the cloud id isn't a site URL", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeJiraClient(
    {
      issuesByProject: { ENG: [{ key: "ENG-3" }] },
      issueDetails: {
        "ENG-3": {
          url: "https://acme.atlassian.net/browse/ENG-3",
          fields: { description: "Escalate any severity-1 incident within 15 minutes." },
        },
      },
    },
    calls,
  );

  const chunks = await walkMcpJira({
    token: "t",
    cloudId: "11111111-2222-3333-4444-555555555555",
    projectKeys: ["ENG"],
    connect: async () => client,
  });
  expect(chunks.every((c) => c.sourcePath === "https://acme.atlassian.net/browse/ENG-3")).toBe(true);
});

test("converts an ADF description and comment body into plain text, dropping a mentioned user's account id", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeJiraClient(
    {
      issuesByProject: { ENG: [{ key: "ENG-4" }] },
      issueDetails: {
        "ENG-4": {
          fields: {
            summary: "On-call escalation",
            description: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "Page " },
                    { type: "mention", attrs: { id: "acct-999", text: "@On-call Lead" } },
                    { type: "text", text: " for any sev-1." },
                  ],
                },
              ],
            },
            comment: {
              comments: [
                {
                  body: {
                    type: "doc",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Confirmed, escalating now." }] }],
                  },
                },
              ],
            },
          },
        },
      },
    },
    calls,
  );

  const chunks = await walkMcpJira({
    token: "t",
    cloudId: "https://acme.atlassian.net",
    projectKeys: ["ENG"],
    connect: async () => client,
  });
  const combined = chunks.map((c) => c.text).join("\n");
  expect(combined).toContain("Page @On-call Lead for any sev-1.");
  expect(combined).toContain("Confirmed, escalating now.");
  expect(combined).not.toContain("acct-999");
});

test("a flattened response with no nested fields container still parses (defensive shape handling)", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeJiraClient(
    {
      issuesByProject: { ENG: [{ key: "ENG-5" }] },
      issueDetails: { "ENG-5": { summary: "Flat shape", description: "Still readable without a fields wrapper." } },
    },
    calls,
  );

  const chunks = await walkMcpJira({
    token: "t",
    cloudId: "https://acme.atlassian.net",
    projectKeys: ["ENG"],
    connect: async () => client,
  });
  expect(chunks.map((c) => c.text).join("\n")).toContain("Still readable without a fields wrapper.");
});

test("never calls a write tool -- only the declared read tools appear in the call log", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeJiraClient(
    {
      issuesByProject: { ENG: [{ key: "ENG-1" }] },
      issueDetails: { "ENG-1": { fields: { description: "Some policy text worth chunking here." } } },
    },
    calls,
  );

  await walkMcpJira({ token: "t", cloudId: "https://acme.atlassian.net", projectKeys: ["ENG"], connect: async () => client });

  const toolNames = new Set(calls.map((c) => c.name));
  for (const name of toolNames) {
    expect(["searchJiraIssuesUsingJql", "getJiraIssue", "getAccessibleAtlassianResources"]).toContain(name);
  }
  expect(toolNames.has("createJiraIssue")).toBe(false);
  expect(toolNames.has("editJiraIssue")).toBe(false);
  expect(toolNames.has("addCommentToJiraIssue")).toBe(false);
  expect(toolNames.has("transitionJiraIssue")).toBe(false);
});

test("a getJiraIssue failure propagates -- unlike Linear's separate comments call, Jira has no isolated read to degrade instead", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeJiraClient(
    {
      issuesByProject: { ENG: [{ key: "ENG-1" }] },
      issueDetails: { "ENG-1": { error: true } },
    },
    calls,
  );

  await expect(
    walkMcpJira({ token: "t", cloudId: "https://acme.atlassian.net", projectKeys: ["ENG"], connect: async () => client }),
  ).rejects.toThrow();
});

test("returns no chunks and never connects when cloudId is missing", async () => {
  let connectCalled = false;
  const connect = async () => {
    connectCalled = true;
    return fakeJiraClient({}, []);
  };

  const chunks = await walkMcpJira({ token: "t", cloudId: "", projectKeys: ["ENG"], connect });
  expect(chunks).toEqual([]);
  expect(connectCalled).toBe(false);
});

test("returns no chunks and never connects when projectKeys is empty", async () => {
  let connectCalled = false;
  const connect = async () => {
    connectCalled = true;
    return fakeJiraClient({}, []);
  };

  const chunks = await walkMcpJira({ token: "t", cloudId: "https://acme.atlassian.net", projectKeys: [], connect });
  expect(chunks).toEqual([]);
  expect(connectCalled).toBe(false);
});

test("throws MissingJiraMcpTokenError with no token from any source, and never attempts to connect", async () => {
  let connectCalled = false;
  const connect = async () => {
    connectCalled = true;
    return fakeJiraClient({}, []);
  };

  await expect(
    walkMcpJira({ cloudId: "https://acme.atlassian.net", projectKeys: ["ENG"], connect }),
  ).rejects.toThrow(MissingJiraMcpTokenError);
  expect(connectCalled).toBe(false);
});

test("falls back to GNT_JIRA_MCP_TOKEN, then to a stored token, in that precedence order", async () => {
  process.env.GNT_JIRA_MCP_TOKEN = "env-token";
  const calls: RecordedCall[] = [];
  const client = fakeJiraClient({ issuesByProject: { ENG: [] } }, calls);

  await walkMcpJira({
    storedToken: "stored-token",
    cloudId: "https://acme.atlassian.net",
    projectKeys: ["ENG"],
    connect: async () => client,
  });

  delete process.env.GNT_JIRA_MCP_TOKEN;
  await expect(
    walkMcpJira({
      storedToken: "stored-token",
      cloudId: "https://acme.atlassian.net",
      projectKeys: ["ENG"],
      connect: async () => client,
    }),
  ).resolves.toBeDefined();
});

test("reads every project given, not just the first", async () => {
  const calls: RecordedCall[] = [];
  const client = fakeJiraClient(
    {
      issuesByProject: { ENG: [{ key: "ENG-1" }], OPS: [{ key: "OPS-1" }] },
      issueDetails: {
        "ENG-1": { fields: { description: "Eng project content." } },
        "OPS-1": { fields: { description: "Ops project content." } },
      },
    },
    calls,
  );

  const chunks = await walkMcpJira({
    token: "t",
    cloudId: "11111111-2222-3333-4444-555555555555",
    projectKeys: ["ENG", "OPS"],
    connect: async () => client,
  });

  const sourcePaths = chunks.map((c) => c.sourcePath);
  expect(sourcePaths).toContain("jira/11111111-2222-3333-4444-555555555555/ENG-1");
  expect(sourcePaths).toContain("jira/11111111-2222-3333-4444-555555555555/OPS-1");
});

test("a connection failure surfaces as a clear error rather than an unhandled rejection shape", async () => {
  await expect(
    walkMcpJira({
      token: "t",
      cloudId: "https://acme.atlassian.net",
      projectKeys: ["ENG"],
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
      if (params.name === "searchJiraIssuesUsingJql") throw new Error("boom");
      throw new Error("unexpected");
    },
    async close() {
      closed = true;
    },
  };

  await expect(
    walkMcpJira({ token: "t", cloudId: "https://acme.atlassian.net", projectKeys: ["ENG"], connect: async () => client }),
  ).rejects.toThrow();
  expect(closed).toBe(true);
});

// ---- shared harness assertions (framework README checklist) ----

test("harness: the read-only allowlist is exactly the declared reads", () => {
  assertReadOnlyAllowlistEnforced(jiraAdapter);
});

test("harness: searchJiraIssuesUsingJql strips assignee and custom field data from listed issues", () => {
  assertDeclaredFieldsStripUndeclared(
    jiraAdapter,
    "searchJiraIssuesUsingJql",
    {
      issues: [
        {
          key: "ENG-1",
          fields: {
            summary: "Keep",
            assignee: { emailAddress: "leak@x.com" },
            customfield_10050: "secret-value",
          },
        },
      ],
    },
    ["leak@x.com", "secret-value"],
  );
});

test("harness: getJiraIssue strips assignee, reporter, watcher, custom field, and comment author data", () => {
  assertDeclaredFieldsStripUndeclared(
    jiraAdapter,
    "getJiraIssue",
    {
      fields: {
        summary: "Keep",
        description: "Refund text.",
        assignee: { accountId: "a1", emailAddress: "assignee-leak@x.com", displayName: "A. Gent" },
        reporter: { accountId: "r1", emailAddress: "reporter-leak@x.com" },
        watches: { watchCount: 3, watchers: [{ emailAddress: "watcher-leak@x.com" }] },
        customfield_10050: "internal-secret-value",
        comment: {
          comments: [{ body: "Confirmed.", author: { emailAddress: "comment-author-leak@x.com" } }],
        },
      },
    },
    [
      "assignee-leak@x.com",
      "reporter-leak@x.com",
      "watcher-leak@x.com",
      "internal-secret-value",
      "comment-author-leak@x.com",
    ],
  );
});

test("harness: the token never appears in anything the walk logs", async () => {
  await assertCredentialsNeverLogged(jiraAdapter, {
    responses: {
      searchJiraIssuesUsingJql: () => ({ issues: [] }),
    },
    params: { cloudId: "https://acme.atlassian.net", projectKeys: ["ENG"] },
    token: "super-secret-jira-token",
  });
});

test("harness: walks fixtures into well-formed chunks", async () => {
  const { chunks } = await walkAdapterWithFake(jiraAdapter, {
    responses: {
      searchJiraIssuesUsingJql: () => ({ issues: [{ key: "ENG-1", fields: { summary: "Refund policy" } }] }),
      getJiraIssue: () => ({
        fields: {
          summary: "Refund policy",
          description: "Refunds over $500 require manager approval.",
          comment: { comments: [{ body: "Confirmed by finance." }] },
        },
      }),
    },
    params: { cloudId: "https://acme.atlassian.net", projectKeys: ["ENG"] },
  });
  assertChunksWellFormed(jiraAdapter, chunks);
  expect(chunks.map((c) => c.text).join("\n")).toContain("manager approval");
});

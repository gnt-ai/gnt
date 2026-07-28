// Tests the live-Sentry walker against a fake McpToolClient. See
// mcp-notion.test.ts's own header for why -- no real network call, no real
// @sentry/mcp-server process, ever runs in this file.
//
// search_issues returns one formatted markdown block, not JSON (see
// mcp-sentry.ts's own doc comment on why every read here is declared
// `kind: "prose"`), so the harness's assertDeclaredFieldsStripUndeclared
// doesn't apply -- there's no structured tool to run it against. The
// "issue block with a leaked email/culprit/score survives parsing intact,
// then only its title/status/link end up in a chunk" test below is this
// adapter's equivalent: it proves parseIssueSummaries, not a JSON field
// projection, is what keeps that data out of a chunk.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  assertChunksWellFormed,
  assertCredentialsNeverLogged,
  assertReadOnlyAllowlistEnforced,
  walkAdapterWithFake,
} from "./mcp-framework/harness.js";
import { allowlistOf } from "../../src/prebrain/mcp-framework/index.js";
import { MissingSentryMcpTokenError, sentryAdapter, walkMcpSentry } from "../../src/prebrain/mcp-sentry.js";
import type { McpToolClient } from "../../src/prebrain/mcp-connector.js";

let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env.GNT_SENTRY_MCP_TOKEN;
  delete process.env.GNT_SENTRY_MCP_TOKEN;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.GNT_SENTRY_MCP_TOKEN;
  else process.env.GNT_SENTRY_MCP_TOKEN = originalEnv;
});

// Mirrors the real reference server's formatIssueResults output shape
// (tools/support/search-issues/formatters.ts) -- a "## N. [SHORTID](url)"
// heading, a "**title**" line, then a metadata bullet list that bundles
// user/event counts, an assignee identity, and a code-location culprit
// alongside the Status line this adapter actually reads.
function searchIssuesFixture(): string {
  return [
    "# Issues in **acme-org/backend**",
    "",
    "**Suggested presentation:** Cards work well for these issues, with status, assignee, and issue ID links visible.",
    "",
    "**View these results in Sentry**:",
    "https://acme-org.sentry.io/issues/?query=is%3Aunresolved&project=backend",
    "Please tell the user this dashboard link is available if they want to open the results in Sentry.",
    "",
    "Found **2** issues:",
    "",
    "## 1. [BACKEND-123](https://acme-org.sentry.io/issues/6916805731/)",
    "",
    "**PaymentGatewayTimeoutError: connection to processor timed out**",
    "",
    "- **Status**: unresolved",
    "- **Users**: 42",
    "- **Events**: 1337",
    "- **Assigned to**: jane.doe+leak@acme-corp-fake.test",
    "- **First seen**: 3 days ago",
    "- **Last seen**: 2 hours ago",
    "- **Culprit**: `billing.payments.process_charge`",
    "- **Seer Actionability**: High",
    "",
    "## 2. [BACKEND-456](https://acme-org.sentry.io/issues/9123456780/)",
    "",
    "**KeyError: 'shipping_address' missing from payload**",
    "",
    "- **Status**: resolved",
    "- **Users**: 3",
    "- **Events**: 9",
    "- **First seen**: 10 days ago",
    "- **Last seen**: 9 days ago",
    "",
    "## Next Steps",
    "",
    "- Get more details about a specific issue: Use get_sentry_resource with the issue ID or issue URL",
    "- View event counts: Use search_events for aggregated statistics",
  ].join("\n");
}

function fakeSentryClient(searchIssuesResponse: string, calls: { name: string; args?: Record<string, unknown> }[]): McpToolClient {
  return {
    async callTool(params) {
      calls.push({ name: params.name, args: params.arguments });
      if (params.name === "search_issues") {
        return { content: [{ type: "text", text: searchIssuesResponse }] };
      }
      throw new Error(`unexpected tool call in test fake: ${params.name}`);
    },
    async close() {},
  };
}

test("walks project issues into PrebrainChunks tagged mcp-sentry, using the issue's own Sentry URL as sourcePath", async () => {
  const calls: { name: string; args?: Record<string, unknown> }[] = [];
  const client = fakeSentryClient(searchIssuesFixture(), calls);

  const chunks = await walkMcpSentry({
    token: "t",
    organizationSlug: "acme-org",
    projectSlugs: ["backend"],
    connect: async () => client,
  });

  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.walker).toBe("mcp-sentry");
  }
  const sourcePaths = chunks.map((c) => c.sourcePath);
  expect(sourcePaths).toContain("https://acme-org.sentry.io/issues/6916805731/");
  expect(sourcePaths).toContain("https://acme-org.sentry.io/issues/9123456780/");

  const combined = chunks.map((c) => c.text).join("\n");
  expect(combined).toContain("PaymentGatewayTimeoutError: connection to processor timed out");
  expect(combined).toContain("Status: unresolved");
  expect(combined).toContain("KeyError: 'shipping_address' missing from payload");
  expect(combined).toContain("Status: resolved");
});

test("never carries an issue's assignee identity, counts, culprit, or Seer score into a chunk", async () => {
  const client = fakeSentryClient(searchIssuesFixture(), []);

  const chunks = await walkMcpSentry({
    token: "t",
    organizationSlug: "acme-org",
    projectSlugs: ["backend"],
    connect: async () => client,
  });

  const combined = chunks.map((c) => c.text).join("\n");
  expect(combined).not.toContain("jane.doe+leak@acme-corp-fake.test");
  expect(combined).not.toContain("billing.payments.process_charge");
  expect(combined).not.toContain("Seer Actionability");
  expect(combined).not.toContain("Assigned to");
  expect(combined).not.toContain("Users");
  expect(combined).not.toContain("Events");
  expect(combined).not.toContain("Culprit");
});

test("only calls search_issues during a walk -- never execute_sentry_tool, search_sentry_tools, get_issue_activity, get_issue_details, get_sentry_resource, update_issue, or add_issue_note", async () => {
  const calls: { name: string; args?: Record<string, unknown> }[] = [];
  const client = fakeSentryClient(searchIssuesFixture(), calls);

  await walkMcpSentry({ token: "t", organizationSlug: "acme-org", projectSlugs: ["backend"], connect: async () => client });

  const toolNames = new Set(calls.map((c) => c.name));
  expect(toolNames).toEqual(new Set(["search_issues"]));

  const declared = allowlistOf(sentryAdapter);
  for (const forbidden of [
    "execute_sentry_tool",
    "search_sentry_tools",
    "get_issue_activity",
    "get_issue_details",
    "get_sentry_resource",
    "update_issue",
    "add_issue_note",
    "analyze_issue_with_seer",
    "search_events",
  ]) {
    expect(declared.has(forbidden)).toBe(false);
  }
});

test("an issue block missing a title line is dropped rather than guessed at", async () => {
  const malformed = [
    "## 1. [BACKEND-999](https://acme-org.sentry.io/issues/1/)",
    "",
    "- **Status**: unresolved",
    "",
    "## 2. [BACKEND-1000](https://acme-org.sentry.io/issues/2/)",
    "",
    "**A well-formed issue title**",
    "",
    "- **Status**: ignored",
  ].join("\n");
  const client = fakeSentryClient(malformed, []);

  const chunks = await walkMcpSentry({
    token: "t",
    organizationSlug: "acme-org",
    projectSlugs: ["backend"],
    connect: async () => client,
  });

  const sourcePaths = chunks.map((c) => c.sourcePath);
  expect(sourcePaths).not.toContain("https://acme-org.sentry.io/issues/1/");
  expect(sourcePaths).toContain("https://acme-org.sentry.io/issues/2/");
});

test("returns no chunks and never connects when projectSlugs is empty", async () => {
  let connectCalled = false;
  const connect = async () => {
    connectCalled = true;
    return fakeSentryClient(searchIssuesFixture(), []);
  };

  const chunks = await walkMcpSentry({ token: "t", organizationSlug: "acme-org", projectSlugs: [], connect });
  expect(chunks).toEqual([]);
  expect(connectCalled).toBe(false);
});

test("returns no chunks and never connects when organizationSlug is empty", async () => {
  let connectCalled = false;
  const connect = async () => {
    connectCalled = true;
    return fakeSentryClient(searchIssuesFixture(), []);
  };

  const chunks = await walkMcpSentry({ token: "t", organizationSlug: "", projectSlugs: ["backend"], connect });
  expect(chunks).toEqual([]);
  expect(connectCalled).toBe(false);
});

test("throws MissingSentryMcpTokenError with no token from any source, and never attempts to connect", async () => {
  let connectCalled = false;
  const connect = async () => {
    connectCalled = true;
    return fakeSentryClient(searchIssuesFixture(), []);
  };

  await expect(
    walkMcpSentry({ organizationSlug: "acme-org", projectSlugs: ["backend"], connect }),
  ).rejects.toThrow(MissingSentryMcpTokenError);
  expect(connectCalled).toBe(false);
});

test("reads every project in projectSlugs, not just the first", async () => {
  const responses: Record<string, string> = {
    backend: [
      "## 1. [BACKEND-1](https://acme-org.sentry.io/issues/10/)",
      "",
      "**Backend project issue**",
      "",
      "- **Status**: unresolved",
    ].join("\n"),
    frontend: [
      "## 1. [FRONTEND-1](https://acme-org.sentry.io/issues/20/)",
      "",
      "**Frontend project issue**",
      "",
      "- **Status**: unresolved",
    ].join("\n"),
  };
  const client: McpToolClient = {
    async callTool(params) {
      const projectSlug = params.arguments?.projectSlugOrId as string;
      return { content: [{ type: "text", text: responses[projectSlug] ?? "" }] };
    },
    async close() {},
  };

  const chunks = await walkMcpSentry({
    token: "t",
    organizationSlug: "acme-org",
    projectSlugs: ["backend", "frontend"],
    connect: async () => client,
  });

  const sourcePaths = chunks.map((c) => c.sourcePath);
  expect(sourcePaths).toContain("https://acme-org.sentry.io/issues/10/");
  expect(sourcePaths).toContain("https://acme-org.sentry.io/issues/20/");
});

// ---- shared harness ----

test("harness: read-only allowlist holds -- find_organizations (probe only) and search_issues are the whole surface", () => {
  assertReadOnlyAllowlistEnforced(sentryAdapter);
  expect([...allowlistOf(sentryAdapter)].sort()).toEqual(["find_organizations", "search_issues"]);
});

test("harness: chunks from a fixture walk are well-formed", async () => {
  const { chunks } = await walkAdapterWithFake(sentryAdapter, {
    responses: { search_issues: () => searchIssuesFixture() },
    params: { organizationSlug: "acme-org", projectSlugs: ["backend"] },
  });
  assertChunksWellFormed(sentryAdapter, chunks);
});

test("harness: the token never appears in anything the walk logs", async () => {
  await assertCredentialsNeverLogged(sentryAdapter, {
    responses: { search_issues: () => searchIssuesFixture() },
    params: { organizationSlug: "acme-org", projectSlugs: ["backend"] },
    token: "super-secret-sentry-token",
  });
});

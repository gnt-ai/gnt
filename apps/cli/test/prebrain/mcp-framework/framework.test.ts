// Direct tests for the connector framework itself (connector sprint T1):
// the field projection, the walk runner, the context guards, and the
// connect/disconnect flow. The two real adapters keep their own dedicated
// suites (mcp-notion.test.ts, mcp-monday.test.ts) unchanged; this file
// proves the shared machinery under them, plus drives the smoke-test
// harness against a synthetic adapter to show it is not tailored to
// Notion/monday shapes.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapDashboardToken,
  loadConnectorToken,
  projectToDeclaredFields,
  runConnectFlow,
  runDisconnectFlow,
  runMcpInWalk,
  runOAuthConnectFlow,
  saveConnectorToken,
  validateConnection,
} from "../../../src/prebrain/mcp-framework/index.js";
import { saveApiKey } from "../../../src/credentials.js";
import type { McpInAdapter, McpToolClient } from "../../../src/prebrain/mcp-framework/index.js";
import { chunkText } from "../../../src/prebrain/chunk.js";
import { notionAdapter } from "../../../src/prebrain/mcp-notion.js";
import { mondayAdapter } from "../../../src/prebrain/mcp-monday.js";
import {
  assertChunksWellFormed,
  assertCredentialsNeverLogged,
  assertDeclaredFieldsStripUndeclared,
  assertReadOnlyAllowlistEnforced,
  createFakeMcpClient,
  mcpError,
  walkAdapterWithFake,
} from "./harness.js";

// -- A synthetic adapter, unrelated to Notion/monday, so the framework and
// harness are exercised against a shape neither real connector has. --
class MissingFakeTokenError extends Error {
  constructor() {
    super("no fake token");
    this.name = "MissingFakeTokenError";
  }
}

interface FakeParams {
  ids: string[];
}

const fakeAdapter: McpInAdapter<FakeParams> = {
  id: "fake-mcp",
  walker: "mcp-notion", // any valid PrebrainWalker tag; the runner just stamps it
  label: "Fake",
  tokenEnvVar: "GNT_FAKE_MCP_TOKEN",
  dashboardTokenPath: "fake",
  missingTokenError: () => new MissingFakeTokenError(),
  server: (token) => ({ label: "Fake", command: "true", args: [], env: { FAKE_TOKEN: token } }),
  reads: [
    { tool: "list_things", kind: "structured", fields: ["items", "id", "name"] },
    { tool: "get_thing", kind: "prose" },
  ],
  chunker: chunkText,
  probe: { tool: "list_things" },
  async walk(ctx, { ids }) {
    for (const id of ids) {
      const detail = await ctx.readProse("get_thing", { id });
      ctx.emitDocument({ body: `# Thing ${id}\n\n${detail}`, sourcePath: `things/${id}` });
    }
  },
};

// ---- field projection ----

test("projectToDeclaredFields keeps declared keys and drops everything else", () => {
  const projected = projectToDeclaredFields(
    { id: "1", name: "keep", email: "leak@x.com", phone: "555" },
    new Set(["id", "name"]),
  );
  expect(projected).toEqual({ id: "1", name: "keep" });
});

test("projectToDeclaredFields recurses arrays and nested declared containers", () => {
  const projected = projectToDeclaredFields(
    { items: [{ id: "1", name: "a", secret: { ssn: "x" } }], count: 9 },
    new Set(["items", "id", "name"]),
  );
  expect(projected).toEqual({ items: [{ id: "1", name: "a" }] });
});

test("projectToDeclaredFields drops a nested object whole when its container key is undeclared", () => {
  // "email" is declared as a leaf, but the object holding it isn't -- so it
  // is unreachable, not exposed. This is the HubSpot-style records-leak guard.
  const projected = projectToDeclaredFields({ contact: { email: "e@x.com" } }, new Set(["email"]));
  expect(projected).toEqual({});
});

// ---- runner + context ----

test("runMcpInWalk drives a synthetic adapter into well-formed, tagged chunks", async () => {
  const { chunks, calls } = await walkAdapterWithFake(fakeAdapter, {
    responses: {
      get_thing: (args) => `Body for ${args?.id}: refunds over $500 need manager approval.`,
    },
    params: { ids: ["a", "b"] },
  });

  expect(chunks.length).toBeGreaterThan(0);
  assertChunksWellFormed(fakeAdapter, chunks);
  expect(chunks.map((c) => c.sourcePath)).toContain("things/a");
  expect(calls.map((c) => c.name)).toEqual(["get_thing", "get_thing"]);
});

test("readStructured hands the adapter a response with undeclared fields already stripped", async () => {
  let seen: unknown;
  const probe: McpInAdapter<void> = {
    ...fakeAdapter,
    async walk(ctx) {
      seen = await ctx.readStructured("list_things", {});
      ctx.emitDocument({ body: "", sourcePath: "x" });
    },
  } as unknown as McpInAdapter<void>;

  await runMcpInWalk(probe, {
    token: "t",
    connect: async () =>
      createFakeMcpClient({
        list_things: () => ({ items: [{ id: "1", name: "ok", email: "leak@x.com" }] }),
      }).client,
    params: undefined,
  });

  expect(JSON.stringify(seen)).not.toContain("leak@x.com");
  expect(seen).toEqual({ items: [{ id: "1", name: "ok" }] });
});

test("readProse refuses a tool declared structured, and readStructured refuses a prose tool", async () => {
  const misuse: McpInAdapter<void> = {
    ...fakeAdapter,
    async walk(ctx) {
      await ctx.readProse("list_things", {});
    },
  } as unknown as McpInAdapter<void>;

  await expect(
    runMcpInWalk(misuse, {
      token: "t",
      connect: async () => createFakeMcpClient({ list_things: () => ({ items: [] }) }).client,
      params: undefined,
    }),
  ).rejects.toThrow(/not a declared prose read/);
});

test("runMcpInWalk throws the adapter's own missing-token error and never connects", async () => {
  let connected = false;
  await expect(
    runMcpInWalk(fakeAdapter, {
      connect: async () => {
        connected = true;
        return createFakeMcpClient({}).client;
      },
      params: { ids: [] },
    }),
  ).rejects.toThrow(MissingFakeTokenError);
  expect(connected).toBe(false);
});

test("runMcpInWalk always closes the client, even when the walk throws", async () => {
  let closed = false;
  const client: McpToolClient = {
    async callTool() {
      throw new Error("boom");
    },
    async close() {
      closed = true;
    },
  };
  await expect(
    runMcpInWalk(fakeAdapter, { token: "t", connect: async () => client, params: { ids: ["a"] } }),
  ).rejects.toThrow();
  expect(closed).toBe(true);
});

// ---- validateConnection ----

test("validateConnection runs the probe once and closes; a failing probe throws", async () => {
  let closed = false;
  const ok: McpToolClient = {
    async callTool(params) {
      expect(params.name).toBe("list_things");
      return { content: [{ type: "text", text: "{}" }] };
    },
    async close() {
      closed = true;
    },
  };
  await validateConnection(fakeAdapter, "t", async () => ok);
  expect(closed).toBe(true);

  const bad: McpToolClient = {
    async callTool() {
      return { isError: true, content: [{ type: "text", text: "bad token" }] };
    },
    async close() {},
  };
  await expect(validateConnection(fakeAdapter, "t", async () => bad)).rejects.toThrow(/bad token/);
});

// ---- connect / disconnect flow ----

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "gnt-framework-connect-"));
  process.env.GNT_CONFIG_DIR = configDir;
});
afterEach(() => {
  delete process.env.GNT_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
});

test("runConnectFlow saves the token only after a successful live validation", async () => {
  const saved = await runConnectFlow({
    adapter: fakeAdapter,
    commandName: "gnt connect fake-mcp",
    intro: "paste your token",
    tokenPrompt: "token: ",
    savedHint: "run it",
    readToken: async () => "good-token",
    validate: async () => {},
  });
  expect(saved).toBe(true);
  expect(loadConnectorToken(fakeAdapter)).toBe("good-token");
});

test("runConnectFlow saves nothing when the live validation fails", async () => {
  const saved = await runConnectFlow({
    adapter: fakeAdapter,
    commandName: "gnt connect fake-mcp",
    intro: "paste your token",
    tokenPrompt: "token: ",
    savedHint: "run it",
    readToken: async () => "bad-token",
    validate: async () => {
      throw new Error("401 unauthorized");
    },
  });
  expect(saved).toBe(false);
  expect(loadConnectorToken(fakeAdapter)).toBeUndefined();
});

test("runConnectFlow saves nothing when no token is entered", async () => {
  const saved = await runConnectFlow({
    adapter: fakeAdapter,
    commandName: "gnt connect fake-mcp",
    intro: "paste your token",
    tokenPrompt: "token: ",
    savedHint: "run it",
    readToken: async () => "",
    validate: async () => {},
  });
  expect(saved).toBe(false);
  expect(loadConnectorToken(fakeAdapter)).toBeUndefined();
});

const fakeOauthConfig = {
  authorizationEndpoint: "https://vendor.example.test/oauth/authorize",
  tokenEndpoint: "https://vendor.example.test/oauth/token",
  clientId: "client-123",
  scope: "read",
  port: 51950,
  callbackPath: "/callback",
};

test("runOAuthConnectFlow saves the access token only after a successful live validation", async () => {
  const saved = await runOAuthConnectFlow({
    adapter: fakeAdapter,
    commandName: "gnt connect fake-mcp",
    intro: "opening your browser",
    oauth: fakeOauthConfig,
    savedHint: "run it",
    runOAuth: async () => ({ accessToken: "good-token" }),
    validate: async () => {},
  });
  expect(saved).toBe(true);
  expect(loadConnectorToken(fakeAdapter)).toBe("good-token");
});

test("runOAuthConnectFlow saves nothing when the live validation fails", async () => {
  const saved = await runOAuthConnectFlow({
    adapter: fakeAdapter,
    commandName: "gnt connect fake-mcp",
    intro: "opening your browser",
    oauth: fakeOauthConfig,
    savedHint: "run it",
    runOAuth: async () => ({ accessToken: "bad-token" }),
    validate: async () => {
      throw new Error("401 unauthorized");
    },
  });
  expect(saved).toBe(false);
  expect(loadConnectorToken(fakeAdapter)).toBeUndefined();
});

test("runOAuthConnectFlow saves nothing when the browser authorization itself fails", async () => {
  const saved = await runOAuthConnectFlow({
    adapter: fakeAdapter,
    commandName: "gnt connect fake-mcp",
    intro: "opening your browser",
    oauth: fakeOauthConfig,
    savedHint: "run it",
    runOAuth: async () => {
      throw new Error("Vendor denied authorization: access_denied");
    },
    validate: async () => {},
  });
  expect(saved).toBe(false);
  expect(loadConnectorToken(fakeAdapter)).toBeUndefined();
});

// ---- bootstrapDashboardToken ----

function fakeFetchOnce(respond: (url: string) => { status: number; body: unknown }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status, body } = respond(url);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

test("bootstrapDashboardToken is a no-op for an adapter with no dashboardTokenPath", async () => {
  const noDashboardAdapter = { ...fakeAdapter, dashboardTokenPath: undefined };
  let called = false;
  const fetched = await bootstrapDashboardToken(noDashboardAdapter, (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch);
  expect(fetched).toBeUndefined();
  expect(called).toBe(false);
});

test("bootstrapDashboardToken is a no-op when a local token already exists", async () => {
  saveConnectorToken(fakeAdapter, "already-have-one");
  let called = false;
  const fetched = await bootstrapDashboardToken(fakeAdapter, (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch);
  expect(fetched).toBeUndefined();
  expect(called).toBe(false);
});

test("bootstrapDashboardToken is a no-op when the CLI isn't logged in", async () => {
  let called = false;
  const fetched = await bootstrapDashboardToken(fakeAdapter, (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch);
  expect(fetched).toBeUndefined();
  expect(called).toBe(false);
});

test("bootstrapDashboardToken fetches and locally caches the dashboard's token when logged in", async () => {
  saveApiKey("gnt_test_api_key");
  let capturedAuth: string | null = null;
  const fetchImpl = (async (_input, init) => {
    capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
    return new Response(JSON.stringify({ access_token: "from-dashboard" }), { status: 200 });
  }) as unknown as typeof fetch;

  const fetched = await bootstrapDashboardToken(fakeAdapter, fetchImpl);
  expect(fetched).toBe("from-dashboard");
  expect(capturedAuth).toBe("Bearer gnt_test_api_key");
  // Cached locally -- a second call should never need the network again.
  expect(loadConnectorToken(fakeAdapter)).toBe("from-dashboard");
});

test("bootstrapDashboardToken returns undefined when the org hasn't connected this vendor from the dashboard", async () => {
  saveApiKey("gnt_test_api_key");
  const fetchImpl = fakeFetchOnce(() => ({ status: 404, body: { detail: "not connected" } }));
  const fetched = await bootstrapDashboardToken(fakeAdapter, fetchImpl);
  expect(fetched).toBeUndefined();
  expect(loadConnectorToken(fakeAdapter)).toBeUndefined();
});

test("bootstrapDashboardToken returns undefined on a network error rather than throwing", async () => {
  saveApiKey("gnt_test_api_key");
  const fetchImpl = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const fetched = await bootstrapDashboardToken(fakeAdapter, fetchImpl);
  expect(fetched).toBeUndefined();
});

test("runDisconnectFlow revokes where supported and removes the local token", async () => {
  saveConnectorToken(fakeAdapter, "to-remove");
  let revokedWith: string | undefined;
  const removed = await runDisconnectFlow({
    adapter: fakeAdapter,
    revoke: async (token) => {
      revokedWith = token;
    },
  });
  expect(removed).toBe(true);
  expect(revokedWith).toBe("to-remove");
  expect(loadConnectorToken(fakeAdapter)).toBeUndefined();
});

// ---- harness against the real adapters (proves it fits real shapes) ----

test("harness: read-only allowlist holds for the real Notion and monday adapters", () => {
  assertReadOnlyAllowlistEnforced(notionAdapter);
  assertReadOnlyAllowlistEnforced(mondayAdapter);
});

test("harness: Notion search strips an undeclared record field", () => {
  assertDeclaredFieldsStripUndeclared(
    notionAdapter,
    "API-post-search",
    [{ id: "p1", title: "Handbook", url: "https://notion.so/p1", owner_email: "leak@x.com" }],
    ["leak@x.com"],
  );
});

test("harness: monday board items strip an undeclared record field", () => {
  assertDeclaredFieldsStripUndeclared(
    mondayAdapter,
    "get_board_items_page",
    { items: [{ id: "1", name: "Item", assignee_email: "leak@x.com", column_values: [{ text: "note" }] }] },
    ["leak@x.com"],
  );
});

test("harness: the token never appears in anything an adapter logs", async () => {
  await assertCredentialsNeverLogged(fakeAdapter, {
    responses: { get_thing: () => "some body text worth chunking here." },
    params: { ids: ["a"] },
    token: "super-secret-fake-token",
  });
});

test("harness: mcpError simulates a tool failure the adapter skips over", async () => {
  // monday's walk catches a failing get_updates and still emits the item's
  // own field content -- the framework's skip-and-report bias, exercised
  // through the harness's error fixture.
  const { chunks } = await walkAdapterWithFake(mondayAdapter, {
    responses: {
      get_board_items_page: () => ({ items: [{ id: "1", name: "Item", column_values: [{ text: "keep this text" }] }] }),
      get_updates: () => mcpError("permission denied"),
    },
    params: { boardIds: ["b1"] },
  });
  expect(chunks.map((c) => c.text).join("\n")).toContain("keep this text");
});

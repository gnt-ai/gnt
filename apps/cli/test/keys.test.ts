// Set a temporary config directory before importing the command modules so
// this file never reads or writes a user's real ~/.gnt/credentials.json.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testConfigDir = mkdtempSync(join(tmpdir(), "gnt-keys-test-"));
const previousConfigDir = process.env.GNT_CONFIG_DIR;
process.env.GNT_CONFIG_DIR = testConfigDir;

const { saveApiKey } = await import("../src/credentials.js");
const { createKey, listKeys, revokeKey, rotateKey } = await import("../src/commands/keys.js");

// Bun loads all test files into one process. Restore the prior value after
// imports so this file cannot affect another file's module setup.
if (previousConfigDir === undefined) {
  delete process.env.GNT_CONFIG_DIR;
} else {
  process.env.GNT_CONFIG_DIR = previousConfigDir;
}

const credentialsPath = join(testConfigDir, "credentials.json");

let originalFetch: typeof fetch;
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalExit: typeof process.exit;

let logs: string[];
let errors: string[];
let exitCalls: number[];
let fetchCalls: Array<{ input: string; init?: RequestInit }>;

// eslint-disable-next-line no-control-regex -- strips terminal ANSI color sequences before assertions.
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

function output() {
  return logs.join("\n").replace(ANSI_ESCAPE_PATTERN, "");
}

function errorOutput() {
  return errors.join("\n").replace(ANSI_ESCAPE_PATTERN, "");
}

// Install a fake fetch: record requests and return a supplied API response.
function mockFetch(body: unknown, status = 200) {
  const fetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ input: String(input), init });

    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalLog = console.log;
  originalError = console.error;
  originalExit = process.exit;

  // credentials.ts reads this environment variable at call time.
  process.env.GNT_CONFIG_DIR = testConfigDir;
  saveApiKey("gnt_live_test_key", "key-id");

  logs = [];
  errors = [];
  exitCalls = [];
  fetchCalls = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };

  // Keep the error-path test from terminating Bun itself.
  process.exit = ((code?: number | string) => {
    exitCalls.push(Number(code));
    throw new Error("test process exit");
  }) as unknown as typeof process.exit;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;

  rmSync(credentialsPath, { force: true });

  if (previousConfigDir === undefined) {
    delete process.env.GNT_CONFIG_DIR;
  } else {
    process.env.GNT_CONFIG_DIR = previousConfigDir;
  }
});

test("prints a message when there are no MCP keys", async () => {
  mockFetch([]);

  await listKeys();

  expect(output()).toContain("No MCP keys yet. Create one with `gnt keys create`.");
});

test("lists aligned MCP keys with revoked, used, and unused states", async () => {
  mockFetch([
    {
      id: "a",
      name: "short",
      created_at: "2026-08-01T00:00:00Z",
      last_used_at: null,
      revoked_at: null,
      expires_at: null,
    },
    {
      id: "much-longer-key-id",
      name: "a longer key name",
      created_at: "2026-08-01T00:00:00Z",
      last_used_at: "2026-08-02T08:30:00Z",
      revoked_at: null,
      expires_at: null,
    },
    {
      id: "revoked-id",
      name: null,
      created_at: "2026-08-01T00:00:00Z",
      last_used_at: null,
      revoked_at: "2026-08-02T09:00:00Z",
      expires_at: null,
    },
  ]);

  await listKeys();

  // \s+ accepts the variable padding introduced by padEnd column alignment.
  expect(output()).toMatch(/^a\s+short\s+unused$/m);
  expect(output()).toMatch(
    /^much-longer-key-id\s+a longer key name\s+last used 2026-08-02T08:30:00Z$/m,
  );
  expect(output()).toMatch(/^revoked-id\s+\(unnamed\)\s+revoked$/m);
});

test("creates an unnamed MCP key with name set to null", async () => {
  mockFetch({ key: "gnt_mcp_new_key" });

  await createKey();

  expect(fetchCalls).toHaveLength(1);
  expect(new URL(fetchCalls[0]!.input).pathname).toBe("/v1/settings/mcp-keys");
  expect(fetchCalls[0]!.init?.method).toBe("POST");
  expect(fetchCalls[0]!.init?.body).toBe('{"name":null}');
  expect(output()).toContain("gnt_mcp_new_key");
  expect(output()).toContain("This is shown once — copy it now.");
});

test("creates a named MCP key and prints the MCP URL", async () => {
  mockFetch({ key: "gnt_mcp_named" });

  await createKey("my key");

  expect(fetchCalls[0]!.init?.body).toBe('{"name":"my key"}');
  expect(output()).toContain("MCP URL:");
  expect(output()).toContain("/mcp/");
  expect(output()).toContain("gnt_mcp_named");
});

test("revokes the requested MCP key", async () => {
  mockFetch({});

  await revokeKey("some-id");

  expect(new URL(fetchCalls[0]!.input).pathname).toBe("/v1/settings/mcp-keys/some-id/revoke");
  expect(fetchCalls[0]!.init?.method).toBe("POST");
  expect(output()).toContain("Revoked some-id");
});

test("rotates a key and notes that the old id is now revoked", async () => {
  mockFetch({ key: "gnt_mcp_rotated" });

  await rotateKey("old-key-id");

  expect(new URL(fetchCalls[0]!.input).pathname).toBe("/v1/settings/mcp-keys/old-key-id/rotate");
  expect(fetchCalls[0]!.init?.method).toBe("POST");
  expect(output()).toContain("gnt_mcp_rotated");
  expect(output()).toContain("old-key-id is now revoked");
});

test("prints an error and exits when createKey gets a non-ok response", async () => {
  mockFetch({}, 500);

  await expect(createKey()).rejects.toThrow("test process exit");

  expect(errorOutput()).toContain("Failed to create key (500).");
  expect(exitCalls).toEqual([1]);
});

test("prints an error and exits when listKeys gets a non-ok response", async () => {
  mockFetch({}, 500);

  await expect(listKeys()).rejects.toThrow("test process exit");

  expect(errorOutput()).toContain("Failed to list keys (500).");
  expect(exitCalls).toEqual([1]);
});

test("prints an error and exits when revokeKey gets a non-ok response", async () => {
  mockFetch({}, 500);

  await expect(revokeKey("some-id")).rejects.toThrow("test process exit");

  expect(errorOutput()).toContain("Failed to revoke key (500).");
  expect(exitCalls).toEqual([1]);
});

test("prints an error and exits when rotateKey gets a non-ok response", async () => {
  mockFetch({}, 500);

  await expect(rotateKey("some-id")).rejects.toThrow("test process exit");

  expect(errorOutput()).toContain("Failed to rotate key (500).");
  expect(exitCalls).toEqual([1]);
});

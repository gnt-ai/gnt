// Set a temporary config directory before importing the command modules so
// this file never reads or writes a user's real ~/.gnt/credentials.json.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testConfigDir = mkdtempSync(join(tmpdir(), "gnt-webhook-test-"));
const previousConfigDir = process.env.GNT_CONFIG_DIR;
process.env.GNT_CONFIG_DIR = testConfigDir;

const { saveApiKey } = await import("../src/credentials.js");
const {
  createWebhookToken,
  listWebhookTokens,
  revokeWebhookToken,
} = await import("../src/commands/webhook.js");

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

  // Capture terminal output for assertions.
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

  // Remove this test's fake login credentials.
  rmSync(credentialsPath, { force: true });

  if (previousConfigDir === undefined) {
    delete process.env.GNT_CONFIG_DIR;
  } else {
    process.env.GNT_CONFIG_DIR = previousConfigDir;
  }
});

test("prints a message when there are no webhook tokens", async () => {
  mockFetch([]);

  await listWebhookTokens();

  expect(output()).toContain(
    "No webhook tokens yet. Create one with `gnt webhook create`.",
  );
});

test("lists aligned webhook tokens with revoked, used, and unused states", async () => {
  mockFetch([
    {
      id: "a",
      name: "short",
      created_at: "2026-08-01T00:00:00Z",
      last_used_at: null,
      revoked_at: null,
    },
    {
      id: "much-longer-token-id",
      name: "a longer token name",
      created_at: "2026-08-01T00:00:00Z",
      last_used_at: "2026-08-02T08:30:00Z",
      revoked_at: null,
    },
    {
      id: "revoked-id",
      name: null,
      created_at: "2026-08-01T00:00:00Z",
      last_used_at: null,
      revoked_at: "2026-08-02T09:00:00Z",
    },
  ]);

  await listWebhookTokens();

  // \s+ accepts the variable padding introduced by padEnd column alignment.
  expect(output()).toMatch(/^a\s+short\s+unused$/m);
  expect(output()).toMatch(
    /^much-longer-token-id\s+a longer token name\s+last used 2026-08-02T08:30:00Z$/m,
  );
  expect(output()).toMatch(/^revoked-id\s+\(unnamed\)\s+revoked$/m);
});

test("creates an unnamed webhook token with name set to null", async () => {
  mockFetch({ ingest_url: "https://api.gntai.dev/v1/ingest/example" });

  await createWebhookToken();

  expect(fetchCalls).toHaveLength(1);
  expect(new URL(fetchCalls[0].input).pathname).toBe("/v1/settings/webhook-tokens");
  expect(fetchCalls[0].init?.method).toBe("POST");
  expect(fetchCalls[0].init?.body).toBe('{"name":null}');
});

test("creates a named webhook token and prints its ingest URL", async () => {
  const ingestUrl = "https://api.gntai.dev/v1/ingest/my-token";
  mockFetch({ ingest_url: ingestUrl });

  await createWebhookToken("my token");

  expect(fetchCalls[0].init?.body).toBe('{"name":"my token"}');
  expect(output()).toContain(ingestUrl);
});

test("revokes the requested webhook token", async () => {
  mockFetch({});

  await revokeWebhookToken("some-id");

  expect(new URL(fetchCalls[0].input).pathname).toBe(
    "/v1/settings/webhook-tokens/some-id/revoke",
  );
  expect(fetchCalls[0].init?.method).toBe("POST");
  expect(output()).toContain("Revoked some-id");
});

test("prints an error and exits when the API response is not ok", async () => {
  mockFetch({}, 500);

  await expect(createWebhookToken()).rejects.toThrow("test process exit");

  expect(errorOutput()).toContain("Failed to create webhook token (500).");
  expect(exitCalls).toEqual([1]);
});

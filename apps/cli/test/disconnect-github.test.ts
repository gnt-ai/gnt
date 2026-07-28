// Tests `gnt disconnect github` against a mocked fetch, same
// GNT_CONFIG_DIR-before-any-import + dynamic-import ordering trick
// logout.test.ts uses (see its own doc comment): credentials.js computes
// its path from GNT_CONFIG_DIR at module load time, and ESM static imports
// are hoisted ahead of everything else in this file regardless of source
// order.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testConfigDir = mkdtempSync(join(tmpdir(), "gnt-disconnect-github-test-"));
process.env.GNT_CONFIG_DIR = testConfigDir;

const { saveApiKey } = await import("../src/credentials.js");
const { disconnectGithub } = await import("../src/commands/disconnect-github.js");

let originalFetch: typeof fetch;
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalExit: typeof process.exit;
let logs: string[];
let errors: string[];

beforeEach(() => {
  saveApiKey("gnt_live_test_key", "11111111-1111-1111-1111-111111111111");
  originalFetch = globalThis.fetch;
  originalLog = console.log;
  originalError = console.error;
  originalExit = process.exit;
  logs = [];
  errors = [];
  console.log = mock((...args: unknown[]) => {
    logs.push(args.join(" "));
  });
  console.error = mock((...args: unknown[]) => {
    errors.push(args.join(" "));
  });
  process.exit = mock(() => {
    throw new Error("process.exit called");
  }) as unknown as typeof process.exit;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  rmSync(testConfigDir, { recursive: true, force: true });
});

test("disconnects a connected repo: GETs the connection, DELETEs it, reports the repo removed", async () => {
  const fetchMock = mock((url: string, init?: RequestInit) => {
    if (!init || !init.method) {
      return Promise.resolve(
        new Response(JSON.stringify({ connected: true, repo_url: "https://github.com/acme/widgets" }), { status: 200 }),
      );
    }
    expect(init.method).toBe("DELETE");
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await disconnectGithub();

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(logs.join("\n")).toContain("Disconnected https://github.com/acme/widgets");
});

test("is a no-op, not an error, when nothing is connected", async () => {
  const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify({ connected: false }), { status: 200 })));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await disconnectGithub();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(logs.join("\n")).toContain("No GitHub connection to disconnect.");
});

test("treats a 404 from the DELETE call itself as a graceful no-op, not a failure", async () => {
  const fetchMock = mock((_url: string, init?: RequestInit) => {
    if (!init || !init.method) {
      return Promise.resolve(
        new Response(JSON.stringify({ connected: true, repo_url: "https://github.com/acme/widgets" }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ detail: "not connected" }), { status: 404 }));
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await disconnectGithub();

  expect(logs.join("\n")).toContain("No GitHub connection to disconnect.");
});

test("exits non-zero and reports the actual detail on a GET failure, not just the status", async () => {
  const fetchMock = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ detail: "invalid api key" }), { status: 401 })),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await expect(disconnectGithub()).rejects.toThrow("process.exit called");

  expect(errors.join("\n")).toContain("Failed to look up the current connection (401): invalid api key");
});

test("exits non-zero and reports the status on an unexpected DELETE failure", async () => {
  const fetchMock = mock((_url: string, init?: RequestInit) => {
    if (!init || !init.method) {
      return Promise.resolve(
        new Response(JSON.stringify({ connected: true, repo_url: "https://github.com/acme/widgets" }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ detail: "server error" }), { status: 500 }));
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await expect(disconnectGithub()).rejects.toThrow("process.exit called");

  expect(errors.join("\n")).toContain("Failed to disconnect (500)");
});

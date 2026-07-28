// Same GNT_CONFIG_DIR-before-import pattern as test/logout.test.ts -- avoids
// touching a real user's actual ~/.gnt/credentials.json.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testConfigDir = mkdtempSync(join(tmpdir(), "gnt-gaps-test-"));
process.env.GNT_CONFIG_DIR = testConfigDir;

const { saveApiKey } = await import("../src/credentials.js");
const { gaps } = await import("../src/commands/gaps.js");

const credentialsPath = join(testConfigDir, "credentials.json");

let originalFetch: typeof fetch;
let logs: string[];
let originalLog: typeof console.log;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  saveApiKey("gnt_live_test_key", "key-id");
  logs = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  rmSync(credentialsPath, { force: true });
});

test("prints a plain message when there are no gaps", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify([]), { status: 200 })),
  ) as unknown as typeof fetch;

  await gaps();

  expect(logs.join("\n")).toContain("No coverage gaps logged yet.");
});

test("points users at `gnt keys create` instead of reading credentials.json directly", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify([{ tool: "search_rules", query: "x", count: 1, last_seen: "2026-07-17T00:00:00Z" }]), { status: 200 })),
  ) as unknown as typeof fetch;

  await gaps();

  const output = logs.join("\n");
  expect(output).toContain("gnt keys create");
  expect(output).not.toContain("credentials.json");
});

test("calls GET /v1/gaps with the bearer token", async () => {
  const fetchMock = mock(() =>
    Promise.resolve(new Response(JSON.stringify([]), { status: 200 })),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await gaps();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toContain("/v1/gaps");
  expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer gnt_live_test_key");
});

test("lists each gap with a copy-pasteable propose-a-rule curl hint", async () => {
  const body = [
    { tool: "search_rules", query: "refund policy", count: 4, last_seen: "2026-07-16T00:00:00Z" },
    { tool: "check_action", query: "send a wire transfer", count: 1, last_seen: "2026-07-17T00:00:00Z" },
  ];
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
  ) as unknown as typeof fetch;

  await gaps();

  const output = logs.join("\n");
  expect(output).toContain("refund policy");
  expect(output).toContain("search_rules");
  expect(output).toContain("asked 4x");
  expect(output).toContain("send a wire transfer");
  expect(output).toContain("check_action");
  expect(output).toContain('curl -s -X POST');
  expect(output).toContain("/v1/rules\"");
  expect(output).toContain("/submit");
});

test("a query containing a single quote produces a shell-safe curl command", async () => {
  const body = [
    { tool: "search_rules", query: "what's our refund policy", count: 1, last_seen: "2026-07-17T00:00:00Z" },
  ];
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
  ) as unknown as typeof fetch;

  await gaps();

  const output = logs.join("\n");
  // The single quote inside the query must be escaped ('\'') rather than
  // left as a bare quote, which would prematurely close the -d '...'
  // shell argument and break the command.
  expect(output).toContain("what'\\''s our refund policy");
});

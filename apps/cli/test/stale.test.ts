// Same GNT_CONFIG_DIR-before-import pattern as test/gaps.test.ts -- avoids
// touching a real user's actual ~/.gnt/credentials.json.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testConfigDir = mkdtempSync(join(tmpdir(), "gnt-stale-test-"));
process.env.GNT_CONFIG_DIR = testConfigDir;

const { saveApiKey } = await import("../src/credentials.js");
const { stale } = await import("../src/commands/stale.js");

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

test("prints a plain message when nothing is due", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ count: 0, rules: [] }), { status: 200 })),
  ) as unknown as typeof fetch;

  await stale();

  expect(logs.join("\n")).toContain("No rules are due for re-validation.");
});

test("calls GET /v1/rules/staleness/due with the bearer token", async () => {
  const fetchMock = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ count: 0, rules: [] }), { status: 200 })),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await stale();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toContain("/v1/rules/staleness/due");
  expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer gnt_live_test_key");
});

test("lists each stale rule with its age, freshness estimate, and next-step hints", async () => {
  const body = {
    count: 2,
    rules: [
      {
        rule_id: "rule-1",
        title: "Refund window",
        age_days: 46.2,
        freshness_score: 0.631,
        estimate: true,
        computed_at: "2026-07-17T03:00:00Z",
      },
      {
        rule_id: "rule-2",
        title: "Escalation contact",
        age_days: 90.0,
        freshness_score: 0.407,
        estimate: true,
        computed_at: "2026-07-17T03:00:00Z",
      },
    ],
  };
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
  ) as unknown as typeof fetch;

  await stale();

  const output = logs.join("\n");
  expect(output).toContain("Rules due for re-validation (2):");
  expect(output).toContain("decay estimate, not a verified fact");
  expect(output).toContain("Refund window");
  expect(output).toContain("46 days old");
  expect(output).toContain("freshness 63% (estimate)");
  expect(output).toContain("Escalation contact");
  expect(output).toContain("90 days old");
  expect(output).toContain("/v1/rules/rule-1/deprecate");
  expect(output).toContain("/v1/rules/rule-1/edit");
});

test("exits with a failure message when the request fails", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response("", { status: 500 })),
  ) as unknown as typeof fetch;
  const originalExit = process.exit;
  const exitCalls: number[] = [];
  // @ts-expect-error -- stubbing process.exit for the test
  process.exit = (code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error("process.exit called");
  };
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };

  try {
    await expect(stale()).rejects.toThrow("process.exit called");
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }

  expect(exitCalls).toEqual([1]);
  expect(errors.join("\n")).toContain("Failed to fetch rules due for re-validation (500).");
});

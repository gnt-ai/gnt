// Same GNT_CONFIG_DIR-before-import pattern as test/stale.test.ts -- avoids
// touching a real user's actual ~/.gnt/credentials.json. Covers only the
// non-interactive surface of review.ts (see the issue this closes): error
// formatting, the timed-out/non-ok/success fetch paths, and the box-width
// edge case. The j/k/a/r/q keypress loop and render() box drawing are real
// interactive-terminal territory and are intentionally left uncovered.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testConfigDir = mkdtempSync(join(tmpdir(), "gnt-review-test-"));
process.env.GNT_CONFIG_DIR = testConfigDir;

const { saveApiKey } = await import("../src/credentials.js");
const { describeErrorDetail, fetchPending, actOnRule, boxWidth, review } = await import(
  "../src/commands/review.js"
);

const credentialsPath = join(testConfigDir, "credentials.json");

let originalFetch: typeof fetch;
let originalExit: typeof process.exit;
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalColumns: number | undefined;
let originalStdinIsTTY: boolean | undefined;
let originalStdoutIsTTY: boolean | undefined;
let logs: string[];
let errors: string[];
let exitCalls: number[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalExit = process.exit;
  originalLog = console.log;
  originalError = console.error;
  originalColumns = process.stdout.columns;
  originalStdinIsTTY = process.stdin.isTTY;
  originalStdoutIsTTY = process.stdout.isTTY;

  saveApiKey("gnt_live_test_key", "key-id");

  logs = [];
  errors = [];
  exitCalls = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  // @ts-expect-error -- stubbing process.exit for the test, same pattern as stale.test.ts
  process.exit = (code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error("process.exit called");
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  console.log = originalLog;
  console.error = originalError;
  Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true });
  Object.defineProperty(process.stdin, "isTTY", { value: originalStdinIsTTY, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: originalStdoutIsTTY, configurable: true });
  rmSync(credentialsPath, { force: true });
});

test("describeErrorDetail: a non-empty string detail passes through unchanged", () => {
  expect(describeErrorDetail("rule body is required", 422)).toBe("rule body is required");
});

test("describeErrorDetail: undefined or null falls back to the status message", () => {
  expect(describeErrorDetail(undefined, 500)).toBe("request failed (500)");
  expect(describeErrorDetail(null, 503)).toBe("request failed (503)");
});

test("describeErrorDetail: an object or array detail gets JSON-stringified", () => {
  const issues = [{ loc: ["body", "title"], msg: "field required" }];
  expect(describeErrorDetail(issues, 422)).toBe(JSON.stringify(issues));
  expect(describeErrorDetail({ msg: "bad" }, 422)).toBe(JSON.stringify({ msg: "bad" }));
});

test("fetchPending: a timed-out request exits 1 with a timeout message", async () => {
  globalThis.fetch = mock(() =>
    Promise.reject(new DOMException("The operation was aborted.", "AbortError")),
  ) as unknown as typeof fetch;

  await expect(fetchPending("gnt_live_test_key")).rejects.toThrow("process.exit called");

  expect(exitCalls).toEqual([1]);
  expect(errors.join("\n")).toContain("Timed out fetching rules for review.");
});

test("fetchPending: a non-ok response exits 1 with the status in the message", async () => {
  globalThis.fetch = mock(() => Promise.resolve(new Response("", { status: 500 }))) as unknown as typeof fetch;

  await expect(fetchPending("gnt_live_test_key")).rejects.toThrow("process.exit called");

  expect(exitCalls).toEqual([1]);
  expect(errors.join("\n")).toContain("Failed to fetch rules for review (500).");
});

test("fetchPending: a successful response returns the parsed rule list", async () => {
  const rules = [{ id: "r1", title: "Refund window", body: "...", confidence: 0.8, tags: [], version: 1 }];
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify(rules), { status: 200 })),
  ) as unknown as typeof fetch;

  await expect(fetchPending("gnt_live_test_key")).resolves.toEqual(rules);
});

test("actOnRule: a timed-out request returns 'request timed out'", async () => {
  globalThis.fetch = mock(() =>
    Promise.reject(new DOMException("The operation was aborted.", "AbortError")),
  ) as unknown as typeof fetch;

  const result = await actOnRule("gnt_live_test_key", "rule-1", "propose");

  expect(result).toEqual({ error: "request timed out" });
});

test("actOnRule: a non-ok response runs its body through describeErrorDetail", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ detail: "rule already proposed" }), { status: 409 })),
  ) as unknown as typeof fetch;

  const result = await actOnRule("gnt_live_test_key", "rule-1", "propose");

  expect(result).toEqual({ error: "rule already proposed" });
});

test("actOnRule: a successful propose with a pr_url returns it with no error", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ pr_url: "https://github.com/org/repo/pull/1" }), { status: 200 }),
    ),
  ) as unknown as typeof fetch;

  const result = await actOnRule("gnt_live_test_key", "rule-1", "propose");

  expect(result).toEqual({ error: null, prUrl: "https://github.com/org/repo/pull/1" });
});

test("actOnRule: a successful propose with no pr_url is an error despite the 2xx", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
  ) as unknown as typeof fetch;

  const result = await actOnRule("gnt_live_test_key", "rule-1", "propose");

  expect(result).toEqual({ error: "server accepted the proposal but returned no PR url" });
});

test("boxWidth: a wide terminal clamps to MAX_BOX_WIDTH (76)", () => {
  Object.defineProperty(process.stdout, "columns", { value: 200, configurable: true });
  expect(boxWidth()).toBe(76);
});

test("boxWidth: a terminal narrower than MIN_BOX_WIDTH returns the available width, not the floor", () => {
  Object.defineProperty(process.stdout, "columns", { value: 20, configurable: true });
  expect(boxWidth()).toBe(16);
});

test("boxWidth: columns undefined falls back to treating the terminal as 80 columns wide", () => {
  Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
  expect(boxWidth()).toBe(76);
});

test("review(): zero pending rules prints a message and returns without touching stdin", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify([]), { status: 200 })),
  ) as unknown as typeof fetch;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const listenerCountBefore = process.stdin.listenerCount("keypress");

  await review();

  expect(logs.join("\n")).toContain("Nothing to review.");
  expect(process.stdin.listenerCount("keypress")).toBe(listenerCountBefore);
});

test("review(): a non-TTY stdin or stdout fails before any keypress listener attaches", async () => {
  const rules = [{ id: "r1", title: "Refund window", body: "...", confidence: 0.8, tags: [], version: 1 }];
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify(rules), { status: 200 })),
  ) as unknown as typeof fetch;
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const listenerCountBefore = process.stdin.listenerCount("keypress");

  await expect(review()).rejects.toThrow("process.exit called");

  expect(exitCalls).toEqual([1]);
  expect(errors.join("\n")).toContain("gnt review needs an interactive terminal.");
  expect(process.stdin.listenerCount("keypress")).toBe(listenerCountBefore);
});

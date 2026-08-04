// Tests `gnt connect slack` against mocked fetch/open — same shape as
// connect-github.test.ts (install URL → open browser → poll until connected).
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testConfigDir = mkdtempSync(join(tmpdir(), "gnt-connect-slack-test-"));
process.env.GNT_CONFIG_DIR = testConfigDir;

let openShouldThrow = false;
const openMock = mock(() => {
  if (openShouldThrow) return Promise.reject(new Error("no browser"));
  return Promise.resolve();
});
mock.module("open", () => ({ default: openMock }));

const { saveApiKey } = await import("../src/credentials.js");
const { connectSlack } = await import("../src/commands/connect-slack.js");

const INSTALL_URL = "https://slack.com/oauth/v2/authorize?state=abc";

let originalFetch: typeof fetch;
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalExit: typeof process.exit;
let originalWrite: typeof process.stdout.write;
let originalDateNow: typeof Date.now;
let logs: string[];
let errors: string[];
let written: string[];
let exitCalls: number[];

// eslint-disable-next-line no-control-regex -- strips terminal ANSI color sequences before assertions.
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_PATTERN, "");
}

beforeEach(() => {
  saveApiKey("gnt_live_test_key", "11111111-1111-1111-1111-111111111111");
  originalFetch = globalThis.fetch;
  originalLog = console.log;
  originalError = console.error;
  originalExit = process.exit;
  originalWrite = process.stdout.write;
  originalDateNow = Date.now;
  logs = [];
  errors = [];
  written = [];
  exitCalls = [];
  openShouldThrow = false;
  openMock.mockClear();

  console.log = mock((...args: unknown[]) => {
    logs.push(args.join(" "));
  });
  console.error = mock((...args: unknown[]) => {
    errors.push(args.join(" "));
  });
  process.exit = mock((code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error("process.exit called");
  }) as unknown as typeof process.exit;
  // spinner() writes straight to process.stdout in non-TTY mode (bun test).
  process.stdout.write = mock((chunk: string) => {
    written.push(chunk);
    return true;
  }) as unknown as typeof process.stdout.write;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  process.stdout.write = originalWrite;
  Date.now = originalDateNow;
  rmSync(testConfigDir, { recursive: true, force: true });
});

test("exits non-zero when the install-url call fails", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ detail: "slack not configured" }), { status: 502 })),
  ) as unknown as typeof fetch;

  await expect(connectSlack()).rejects.toThrow("process.exit called");

  expect(exitCalls).toEqual([1]);
  expect(stripAnsi(errors.join("\n"))).toContain("Failed to start Slack connect (502)");
  expect(openMock).not.toHaveBeenCalled();
});

test("opens the install URL and reports success once slack_connected shows up on poll", async () => {
  let pollCount = 0;
  globalThis.fetch = mock((url: string) => {
    if (String(url).includes("/v1/slack/install-url")) {
      return Promise.resolve(new Response(JSON.stringify({ url: INSTALL_URL }), { status: 200 }));
    }
    // GET /v1/brain/summary — not connected the first call, connected the second.
    pollCount += 1;
    const body = pollCount === 1 ? { slack_connected: false } : { slack_connected: true };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as unknown as typeof fetch;

  await connectSlack();

  expect(stripAnsi(logs.join("\n"))).toContain(INSTALL_URL);
  expect(openMock).toHaveBeenCalledWith(INSTALL_URL);
  expect(stripAnsi(written.join(""))).toContain("Slack connected.");
  expect(exitCalls).toHaveLength(0);
});

test("falls back to a manual-open message when open() throws, then still polls to success", async () => {
  openShouldThrow = true;
  let pollCount = 0;
  globalThis.fetch = mock((url: string) => {
    if (String(url).includes("/v1/slack/install-url")) {
      return Promise.resolve(new Response(JSON.stringify({ url: INSTALL_URL }), { status: 200 }));
    }
    pollCount += 1;
    const body = pollCount === 1 ? { slack_connected: false } : { slack_connected: true };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as unknown as typeof fetch;

  await connectSlack();

  expect(stripAnsi(logs.join("\n"))).toContain("Couldn't open a browser automatically");
  expect(stripAnsi(written.join(""))).toContain("Slack connected.");
  expect(exitCalls).toHaveLength(0);
});

test("timeout path prints Still waiting and does not call process.exit", async () => {
  // Advance Date.now past the 5-minute deadline after the first poll so we
  // don't literally wait out POLL_TIMEOUT_MS — one real POLL_INTERVAL_MS sleep
  // is enough to enter the loop body once.
  let now = 0;
  Date.now = () => now;

  globalThis.fetch = mock((url: string) => {
    if (String(url).includes("/v1/slack/install-url")) {
      return Promise.resolve(new Response(JSON.stringify({ url: INSTALL_URL }), { status: 200 }));
    }
    // After this poll returns, the next while-condition Date.now() check
    // must see a time past the deadline (Date.now() at start + 5 minutes).
    now = 5 * 60 * 1000 + 1;
    return Promise.resolve(new Response(JSON.stringify({ slack_connected: false }), { status: 200 }));
  }) as unknown as typeof fetch;

  await connectSlack();

  expect(stripAnsi(written.join(""))).toContain("Still waiting");
  expect(stripAnsi(written.join(""))).toContain("gnt status");
  expect(exitCalls).toHaveLength(0);
});

// Covers the seven `gnt connect <x>-mcp` command wrappers -- each is a thin
// config object handed to the connector framework's shared flow-runner, and
// none of them had a test asserting they actually pass the right adapter and
// non-empty copy through. The adapters themselves (mcp-jira.ts and friends)
// are tested elsewhere; this file only pins down the wrapper -> runner wiring.
//
// mock.module resolves relative to this file, not to whichever command file
// does the importing (same precedent as connect-hermes.test.ts mocking
// ../src/hermes-config.js) -- "../src/prebrain/mcp-framework/index.js" here
// is the same resolved path every wrapper below imports as
// "../prebrain/mcp-framework/index.js". The override applies to every test
// file sharing this process, not just this one (same note org.test.ts's own
// mock.module leaves for config.js) -- and unlike config.js's static
// constants, framework.test.ts imports this exact barrel to test
// runConnectFlow/runOAuthConnectFlow's own real behavior directly, so
// swapping in fakes for the whole process (even temporarily) breaks that
// file regardless of afterAll ordering. Instead of replacing these three
// exports outright, each one here delegates to the real implementation
// unless `intercepting` is on, which is only true for the duration of a
// single connectXMcp() call inside this file's own tests.
import { beforeEach, expect, mock, test } from "bun:test";
import * as realReadline from "node:readline";

type FlowKind = "connect" | "oauth" | "managed";

interface RecordedCall {
  kind: FlowKind;
  options: Record<string, unknown>;
}

let calls: RecordedCall[] = [];
let intercepting = false;

const realFramework = await import("../src/prebrain/mcp-framework/index.js");
// Captured into plain locals *before* mock.module runs -- realFramework
// itself is a live-bound namespace object, so reading .runConnectFlow off
// it lazily (inside the replacement below) would just call the mock again
// once mock.module has patched it, recursing forever.
const realRunConnectFlow = realFramework.runConnectFlow;
const realRunOAuthConnectFlow = realFramework.runOAuthConnectFlow;
const realRunManagedConnectFlow = realFramework.runManagedConnectFlow;

mock.module("../src/prebrain/mcp-framework/index.js", () => ({
  ...realFramework,
  runConnectFlow: async (options: Record<string, unknown>) => {
    if (!intercepting) return realRunConnectFlow(options as never);
    calls.push({ kind: "connect", options });
    return true;
  },
  runOAuthConnectFlow: async (options: Record<string, unknown>) => {
    if (!intercepting) return realRunOAuthConnectFlow(options as never);
    calls.push({ kind: "oauth", options });
    return true;
  },
  runManagedConnectFlow: async (options: Record<string, unknown>) => {
    if (!intercepting) return realRunManagedConnectFlow(options as never);
    calls.push({ kind: "managed", options });
    return true;
  },
}));

async function withIntercept<T>(fn: () => Promise<T>): Promise<T> {
  intercepting = true;
  try {
    return await fn();
  } finally {
    intercepting = false;
  }
}

// Only connect-monday-mcp.ts reads a line directly (the board id prompt) --
// none of the other six wrappers touch readline, so this stub doesn't need
// to fall back to the real implementation for anything else in this file.
let boardIdAnswer = "board-123";
mock.module("node:readline", () => ({
  ...realReadline,
  createInterface: () => ({
    question: (_prompt: string, cb: (answer: string) => void) => {
      cb(boardIdAnswer);
    },
    close: () => {},
  }),
}));

const { connectJiraMcp } = await import("../src/commands/connect-jira-mcp.js");
const { connectLinearMcp } = await import("../src/commands/connect-linear-mcp.js");
const { connectMondayMcp } = await import("../src/commands/connect-monday-mcp.js");
const { connectNotionMcp } = await import("../src/commands/connect-notion-mcp.js");
const { connectSentryMcp } = await import("../src/commands/connect-sentry-mcp.js");
const { connectZoomMcp } = await import("../src/commands/connect-zoom-mcp.js");
const { connectGranolaMcp } = await import("../src/commands/connect-granola-mcp.js");

const { jiraAdapter } = await import("../src/prebrain/mcp-jira.js");
const { linearAdapter } = await import("../src/prebrain/mcp-linear.js");
const { mondayAdapter } = await import("../src/prebrain/mcp-monday.js");
const { notionAdapter } = await import("../src/prebrain/mcp-notion.js");
const { sentryAdapter } = await import("../src/prebrain/mcp-sentry.js");
const { zoomAdapter } = await import("../src/prebrain/mcp-zoom.js");
const { granolaAdapter } = await import("../src/prebrain/mcp-granola.js");

beforeEach(() => {
  calls = [];
  boardIdAnswer = "board-123";
});

test("connect jira-mcp goes through the managed flow with the jira adapter", async () => {
  await withIntercept(connectJiraMcp);
  expect(calls).toHaveLength(1);
  expect(calls[0].kind).toBe("managed");
  expect(calls[0].options.adapter).toBe(jiraAdapter);
  expect(calls[0].options.intro).toBeTruthy();
  expect(calls[0].options.savedHint).toContain("--mcp-jira");
});

test("connect linear-mcp goes through the oauth flow with the linear adapter", async () => {
  await withIntercept(connectLinearMcp);
  expect(calls).toHaveLength(1);
  expect(calls[0].kind).toBe("oauth");
  expect(calls[0].options.adapter).toBe(linearAdapter);
  expect(calls[0].options.commandName).toBe("gnt connect linear-mcp");
  expect(calls[0].options.intro).toBeTruthy();
  expect(calls[0].options.savedHint).toContain("--mcp-linear");
});

test("connect monday-mcp goes through the connect flow with the monday adapter, after asking for a board id", async () => {
  boardIdAnswer = "board-987";
  // readLine() in connect-monday-mcp.ts checks process.stdin.isTTY before
  // touching readline at all -- false under `bun test`, so it's stubbed
  // true only for this one call and restored right after, rather than for
  // the whole file (Bun runs every test file in one process).
  const originalIsTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  try {
    await withIntercept(connectMondayMcp);
  } finally {
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
  }
  expect(calls).toHaveLength(1);
  expect(calls[0].kind).toBe("connect");
  expect(calls[0].options.adapter).toBe(mondayAdapter);
  expect(calls[0].options.commandName).toBe("gnt connect monday-mcp");
  expect(calls[0].options.tokenPrompt).toBeTruthy();
  expect(calls[0].options.savedHint).toContain("--mcp-monday");
  expect(typeof calls[0].options.validate).toBe("function");
});

test("connect notion-mcp goes through the connect flow with the notion adapter", async () => {
  await withIntercept(connectNotionMcp);
  expect(calls).toHaveLength(1);
  expect(calls[0].kind).toBe("connect");
  expect(calls[0].options.adapter).toBe(notionAdapter);
  expect(calls[0].options.commandName).toBe("gnt connect notion-mcp");
  expect(calls[0].options.tokenPrompt).toBeTruthy();
  expect(calls[0].options.savedHint).toContain("--mcp-notion");
});

test("connect sentry-mcp goes through the connect flow with the sentry adapter", async () => {
  await withIntercept(connectSentryMcp);
  expect(calls).toHaveLength(1);
  expect(calls[0].kind).toBe("connect");
  expect(calls[0].options.adapter).toBe(sentryAdapter);
  expect(calls[0].options.commandName).toBe("gnt connect sentry-mcp");
  expect(calls[0].options.tokenPrompt).toBeTruthy();
  expect(calls[0].options.savedHint).toContain("--mcp-sentry");
});

test("connect zoom-mcp goes through the connect flow with the zoom adapter", async () => {
  await withIntercept(connectZoomMcp);
  expect(calls).toHaveLength(1);
  expect(calls[0].kind).toBe("connect");
  expect(calls[0].options.adapter).toBe(zoomAdapter);
  expect(calls[0].options.commandName).toBe("gnt connect zoom-mcp");
  expect(calls[0].options.tokenPrompt).toBeTruthy();
  expect(calls[0].options.savedHint).toContain("--mcp-zoom");
});

test("connect granola-mcp goes through the connect flow with the granola adapter", async () => {
  await withIntercept(connectGranolaMcp);
  expect(calls).toHaveLength(1);
  expect(calls[0].kind).toBe("connect");
  expect(calls[0].options.adapter).toBe(granolaAdapter);
  expect(calls[0].options.commandName).toBe("gnt connect granola-mcp");
  expect(calls[0].options.tokenPrompt).toBeTruthy();
  expect(calls[0].options.savedHint).toContain("--mcp-granola");
});

// Same GNT_CONFIG_DIR-before-import sandbox as test/gaps.test.ts -- avoids
// touching a real user's actual ~/.gnt/mcp-tokens.json, since
// collectSourcePicker's own availability check reads real stored tokens
// (unlike collectCompanyProfile, which never touches credentials.ts).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ask } from "../../src/prebrain/profile.js";
import type { SourceEntry } from "../../src/prebrain/source-picker.js";

const testConfigDir = mkdtempSync(join(tmpdir(), "gnt-source-picker-test-"));
process.env.GNT_CONFIG_DIR = testConfigDir;

const { saveMcpToken } = await import("../../src/credentials.js");
const { FIGMA_TOKEN_ID } = await import("../../src/prebrain/figma-comments.js");
const { collectSourcePicker } = await import("../../src/prebrain/source-picker.js");

let originalLog: typeof console.log;

beforeEach(() => {
  originalLog = console.log;
  console.log = () => {};
});

afterEach(() => {
  console.log = originalLog;
  rmSync(join(testConfigDir, "mcp-tokens.json"), { force: true });
});

function scriptedAsk(answers: string[]): Ask {
  const queue = [...answers];
  return async () => {
    if (queue.length === 0) throw new Error("scriptedAsk: ran out of scripted answers");
    return queue.shift() as string;
  };
}

// mcpEntries() (7) + restEntries() (5) + fileEntries() (5) -- every entry
// is always listed now, connected or not, so option numbers are fixed
// regardless of what's actually connected. notion-mcp is 1 (first
// MCP_IN_ADAPTERS registration), Figma is 8 (first of restEntries()),
// docs is 13 (first of fileEntries()).
const NOTION_MCP_OPTION = "1";
const FIGMA_OPTION = "8";
const DOCS_OPTION = "13";

test("with nothing connected and nothing picked, no fields are contributed", async () => {
  const ask = scriptedAsk([""]); // blank at the multi-select -- pick nothing
  const fields = await collectSourcePicker(ask);
  expect(fields).toEqual({});
});

test("picking an already-connected MCP source with no extra scope needed sets its boolean", async () => {
  saveMcpToken("notion-mcp", "fake-notion-token");
  const ask = scriptedAsk([NOTION_MCP_OPTION]);
  const fields = await collectSourcePicker(ask);
  expect(fields).toEqual({ mcpNotion: true });
});

test("picking a connected source that needs scope ids asks for them and merges the answer", async () => {
  saveMcpToken(FIGMA_TOKEN_ID, "fake-figma-token");
  const ask = scriptedAsk([FIGMA_OPTION, "abc123,def456"]);
  const fields = await collectSourcePicker(ask);
  expect(fields).toEqual({ figmaComments: true, figmaFiles: "abc123,def456" });
});

test("a file-based source asks for a path and merges it", async () => {
  const ask = scriptedAsk([DOCS_OPTION, "/tmp/some-docs"]);
  const fields = await collectSourcePicker(ask);
  expect(fields).toEqual({ docs: "/tmp/some-docs" });
});

test("a blank path for a file-based source contributes nothing", async () => {
  const ask = scriptedAsk([DOCS_OPTION, ""]);
  const fields = await collectSourcePicker(ask);
  expect(fields).toEqual({});
});

test("picking multiple sources merges all their fields together", async () => {
  saveMcpToken("notion-mcp", "fake-notion-token");
  const ask = scriptedAsk([`${NOTION_MCP_OPTION},${DOCS_OPTION}`, "/tmp/some-docs"]);
  const fields = await collectSourcePicker(ask);
  expect(fields).toEqual({ mcpNotion: true, docs: "/tmp/some-docs" });
});

// Fake entries below prove the inline-connect wiring itself (run connect(),
// re-check isConnected(), then collect() or skip) without invoking a real
// connect-*.ts flow -- see collectSourcePicker's own comment on why
// buildEntries() is injectable.

test("picking an unconnected source runs its connect() then collects its fields", async () => {
  let connected = false;
  const entries: SourceEntry[] = [
    {
      key: "fake",
      label: "Fake connector",
      isConnected: () => connected,
      connect: async () => {
        connected = true; // simulates a successful `gnt connect fake`
      },
      collect: async () => ({ fakeEnabled: true }),
    },
  ];

  const ask = scriptedAsk(["1"]);
  const fields = await collectSourcePicker(ask, entries);

  expect(fields).toEqual({ fakeEnabled: true });
});

test("an unconnected source whose connect() doesn't succeed is skipped, not collected", async () => {
  const entries: SourceEntry[] = [
    {
      key: "fake",
      label: "Fake connector",
      isConnected: () => false, // stays false even after connect() runs -- e.g. user aborted
      connect: async () => {},
      collect: async () => ({ fakeEnabled: true }),
    },
  ];

  const ask = scriptedAsk(["1"]);
  const fields = await collectSourcePicker(ask, entries);

  expect(fields).toEqual({});
});

test("an unconnected source with no connect() at all is skipped silently", async () => {
  const entries: SourceEntry[] = [
    {
      key: "fake",
      label: "Fake connector",
      isConnected: () => false,
      collect: async () => ({ fakeEnabled: true }),
    },
  ];

  const ask = scriptedAsk(["1"]);
  const fields = await collectSourcePicker(ask, entries);

  expect(fields).toEqual({});
});

test("an already-connected fake entry's label has no \"(not connected yet)\" suffix, an unconnected one does", async () => {
  const logs: string[] = [];
  const originalLog2 = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));

  const entries: SourceEntry[] = [
    { key: "a", label: "Connected Thing", isConnected: () => true, collect: async () => ({}) },
    { key: "b", label: "Unconnected Thing", isConnected: () => false, collect: async () => ({}) },
  ];
  const ask = scriptedAsk([""]);
  await collectSourcePicker(ask, entries);

  console.log = originalLog2;
  const output = logs.join("\n");
  expect(output).toContain("Connected Thing");
  expect(output).not.toContain("Connected Thing (not connected yet)");
  expect(output).toContain("Unconnected Thing (not connected yet)");
});

// Tests the two pure parsers `gnt connect airtable`'s interactive field
// picker is built on -- the only parts of that command worth unit testing
// directly, since the rest is raw-mode terminal I/O (same reasoning
// connect-datadog.ts's own command left untested). These two are what
// decide, from a customer's typed input, which fields get saved into the
// allowlist prebrain/airtable.ts's walker treats as a hard boundary -- see
// airtable.test.ts for proof of what that boundary actually blocks.
//
// Also tests `gnt disconnect airtable` -- unlike the interactive connect
// flow, disconnectAirtable is plain, testable code (one deleteMcpToken
// call), so it's covered directly rather than left untested. Same
// GNT_CONFIG_DIR-before-each pattern as credentials-mcp-tokens.test.ts:
// configDir() in credentials.ts re-reads the env var on every call, so
// setting it in beforeEach is enough.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disconnectAirtable, parseIndexSelection, parseYesNo } from "../src/commands/connect-airtable.js";
import { AIRTABLE_TOKEN_ID, serializeAirtableConfig } from "../src/prebrain/airtable.js";
import { loadMcpToken, saveMcpToken } from "../src/credentials.js";

test("parseYesNo: y/Y/yes (any case) is true, blank takes the default, anything else is false", () => {
  expect(parseYesNo("y")).toBe(true);
  expect(parseYesNo("Y")).toBe(true);
  expect(parseYesNo("yes")).toBe(true);
  expect(parseYesNo("YES")).toBe(true);
  expect(parseYesNo("n")).toBe(false);
  expect(parseYesNo("no")).toBe(false);
  expect(parseYesNo("nah")).toBe(false);
  expect(parseYesNo("")).toBe(false);
  expect(parseYesNo("", true)).toBe(true);
  expect(parseYesNo("  y  ")).toBe(true);
});

test("parseIndexSelection: parses comma-separated 1-indexed picks in selection order, deduplicated", () => {
  expect(parseIndexSelection("2,4", 5)).toEqual([2, 4]);
  expect(parseIndexSelection("1, 3 ,5", 5)).toEqual([1, 3, 5]);
  expect(parseIndexSelection("3,1,3", 5)).toEqual([3, 1]);
});

test("parseIndexSelection: drops out-of-range or non-numeric entries rather than failing the whole selection", () => {
  expect(parseIndexSelection("0,2,99,abc,3", 5)).toEqual([2, 3]);
  expect(parseIndexSelection("", 5)).toEqual([]);
  expect(parseIndexSelection("abc", 5)).toEqual([]);
});

let testConfigDir: string;
let logs: string[];
let originalLog: typeof console.log;

beforeEach(() => {
  testConfigDir = mkdtempSync(join(tmpdir(), "gnt-disconnect-airtable-test-"));
  process.env.GNT_CONFIG_DIR = testConfigDir;
  logs = [];
  originalLog = console.log;
  console.log = mock((...args: unknown[]) => {
    logs.push(args.join(" "));
  });
});

afterEach(() => {
  console.log = originalLog;
  rmSync(testConfigDir, { recursive: true, force: true });
});

test("disconnectAirtable removes a saved connection and reports it removed", async () => {
  saveMcpToken(
    AIRTABLE_TOKEN_ID,
    serializeAirtableConfig({
      token: "airtable-pat-secret",
      baseId: "appBase123",
      baseName: "Support Playbook",
      tables: [{ tableId: "tblNotes", tableName: "Playbook", allowedFields: ["Notes"] }],
    }),
  );

  await disconnectAirtable();

  expect(loadMcpToken(AIRTABLE_TOKEN_ID)).toBeUndefined();
  expect(logs.join("\n")).toContain("Disconnected Airtable");
});

test("disconnectAirtable is a no-op, not an error, when nothing was ever connected", async () => {
  await disconnectAirtable();

  expect(logs.join("\n")).toContain("No stored Airtable connection to remove.");
});

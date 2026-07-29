// Tests the local-only MCP-in token storage --
// saveMcpToken/loadMcpToken -- kept in a file separate from the api_key
// credentials.json tests (see logout.test.ts) since these are a
// deliberately distinct trust boundary (see credentials.ts's own doc
// comment on mcp-tokens.json): this file never calls gnt's API at all.
//
// configDir() in credentials.ts re-reads process.env.GNT_CONFIG_DIR on
// every call (its own doc comment explains why -- bun test shares one
// module cache across every test file in the run), so setting it in
// beforeEach is enough; no import-ordering trick needed.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpToken, saveMcpToken } from "../src/credentials.js";

let testConfigDir: string;

beforeEach(() => {
  testConfigDir = mkdtempSync(join(tmpdir(), "gnt-mcp-tokens-test-"));
  process.env.GNT_CONFIG_DIR = testConfigDir;
});

afterEach(() => {
  rmSync(testConfigDir, { recursive: true, force: true });
});

test("loadMcpToken returns undefined when nothing has been saved", () => {
  expect(loadMcpToken("notion-mcp")).toBeUndefined();
});

test("saves and loads a token round-trip, per server id", () => {
  saveMcpToken("notion-mcp", "notion-secret-abc");
  saveMcpToken("monday-mcp", "monday-secret-xyz");

  expect(loadMcpToken("notion-mcp")).toBe("notion-secret-abc");
  expect(loadMcpToken("monday-mcp")).toBe("monday-secret-xyz");
});

test("writes mcp-tokens.json as its own file, separate from credentials.json", () => {
  saveMcpToken("notion-mcp", "notion-secret-abc");

  const tokensPath = join(testConfigDir, "mcp-tokens.json");
  expect(existsSync(tokensPath)).toBe(true);
  expect(existsSync(join(testConfigDir, "credentials.json"))).toBe(false);

  const raw = JSON.parse(readFileSync(tokensPath, "utf-8"));
  expect(raw).toEqual({ "notion-mcp": "notion-secret-abc" });
});

test("saving one server's token does not clobber another server's already-saved token", () => {
  saveMcpToken("notion-mcp", "first-notion-token");
  saveMcpToken("monday-mcp", "first-monday-token");
  saveMcpToken("notion-mcp", "rotated-notion-token");

  expect(loadMcpToken("notion-mcp")).toBe("rotated-notion-token");
  expect(loadMcpToken("monday-mcp")).toBe("first-monday-token");
});

test("mcp-tokens.json is written 0600, even rewriting a file that pre-existed with looser permissions", () => {
  const tokensPath = join(testConfigDir, "mcp-tokens.json");
  // Simulates a file left over from before 0600 was enforced on every
  // write -- writeFileSync's `mode` option only applies at creation, so
  // without an explicit chmodSync this would silently stay 0644 forever.
  writeFileSync(tokensPath, "{}", { mode: 0o644 });

  saveMcpToken("notion-mcp", "notion-secret-abc");

  expect(statSync(tokensPath).mode & 0o777).toBe(0o600);
});

test("a missing or corrupt mcp-tokens.json is treated as no tokens saved, not a crash", () => {
  const tokensPath = join(testConfigDir, "mcp-tokens.json");
  // No file at all yet:
  expect(loadMcpToken("notion-mcp")).toBeUndefined();

  // A corrupt file:
  saveMcpToken("notion-mcp", "placeholder");
  writeFileSync(tokensPath, "{not valid json");
  expect(loadMcpToken("notion-mcp")).toBeUndefined();
});

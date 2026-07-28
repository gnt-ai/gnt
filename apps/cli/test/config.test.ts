// Regression test for the stale Railway-domain default: every command
// (gnt gaps included) falls back to this constant whenever GNT_API_URL
// isn't set, so a wrong default here silently breaks every real,
// npm-installed user who hasn't overridden it.
import { expect, test } from "bun:test";
import { API_URL, MCP_URL } from "../src/config.js";

test("API_URL defaults to the real production domain, not the old Railway host", () => {
  expect(API_URL).toBe("https://api.gntai.dev");
  expect(API_URL).not.toContain("railway.app");
});

test("MCP_URL is derived from API_URL", () => {
  expect(MCP_URL).toBe(`${API_URL}/mcp/`);
});

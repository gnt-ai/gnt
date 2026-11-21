// Every command (gnt gaps included) falls back to this constant whenever
// GNT_API_URL isn't set, so the default has to be the local self-hosted
// stack, not a dead managed domain.
import { expect, test } from "bun:test";
import { API_URL, MCP_URL } from "../src/config.js";

test("API_URL defaults to a local self-hosted stack", () => {
  expect(API_URL).toBe("http://localhost:8000");
});

test("MCP_URL is derived from API_URL", () => {
  expect(MCP_URL).toBe(`${API_URL}/mcp/`);
});

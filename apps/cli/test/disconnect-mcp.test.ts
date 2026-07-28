// Tests the seven `gnt disconnect <x>-mcp` wrappers (commands/disconnect-mcp.ts).
// runDisconnectFlow itself is already fully covered in
// prebrain/mcp-framework/framework.test.ts -- what's actually worth proving
// here is the wiring: that each wrapper's adapter argument is its own, so
// disconnecting one connector never touches another's stored token. Same
// GNT_CONFIG_DIR-before-each pattern as credentials-mcp-tokens.test.ts.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  disconnectGranolaMcp,
  disconnectJiraMcp,
  disconnectLinearMcp,
  disconnectMondayMcp,
  disconnectNotionMcp,
  disconnectSentryMcp,
  disconnectZoomMcp,
} from "../src/commands/disconnect-mcp.js";
import { loadMcpToken, saveMcpToken } from "../src/credentials.js";

const cases = [
  { name: "notion-mcp", disconnect: disconnectNotionMcp, label: "Notion" },
  { name: "monday-mcp", disconnect: disconnectMondayMcp, label: "monday.com" },
  { name: "linear-mcp", disconnect: disconnectLinearMcp, label: "Linear" },
  { name: "jira-mcp", disconnect: disconnectJiraMcp, label: "Jira" },
  { name: "sentry-mcp", disconnect: disconnectSentryMcp, label: "Sentry" },
  { name: "granola-mcp", disconnect: disconnectGranolaMcp, label: "Granola" },
  { name: "zoom-mcp", disconnect: disconnectZoomMcp, label: "Zoom" },
];

let testConfigDir: string;
let logs: string[];
let originalLog: typeof console.log;

beforeEach(() => {
  testConfigDir = mkdtempSync(join(tmpdir(), "gnt-disconnect-mcp-test-"));
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

for (const { name, disconnect, label } of cases) {
  test(`disconnect ${name} removes only its own stored token`, async () => {
    for (const other of cases) saveMcpToken(other.name, `${other.name}-secret`);

    await disconnect();

    expect(loadMcpToken(name)).toBeUndefined();
    for (const other of cases) {
      if (other.name !== name) expect(loadMcpToken(other.name)).toBe(`${other.name}-secret`);
    }
    expect(logs.join("\n")).toContain(`Disconnected ${label}`);
  });

  test(`disconnect ${name} is a no-op, not an error, when nothing was ever connected`, async () => {
    await disconnect();

    expect(logs.join("\n")).toContain(`No stored ${label} token`);
  });
}

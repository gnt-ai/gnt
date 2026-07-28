// Tests the four REST-direct disconnect commands (Figma, Datadog, GitLab
// threads, HubSpot) -- each is a single deleteMcpToken call colocated in its
// own connect-*.ts file, same shape as disconnectAirtable
// (connect-airtable.test.ts already covers that one). Same
// GNT_CONFIG_DIR-before-each pattern as credentials-mcp-tokens.test.ts.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disconnectDatadog } from "../src/commands/connect-datadog.js";
import { disconnectFigma } from "../src/commands/connect-figma.js";
import { disconnectGitlabThreads } from "../src/commands/connect-gitlab-threads.js";
import { disconnectHubspot } from "../src/commands/connect-hubspot.js";
import { loadMcpToken, saveMcpToken } from "../src/credentials.js";
import { DATADOG_TOKEN_ID } from "../src/prebrain/datadog-notebooks.js";
import { FIGMA_TOKEN_ID } from "../src/prebrain/figma-comments.js";
import { GITLAB_TOKEN_ID } from "../src/prebrain/gitlab-threads.js";
import { HUBSPOT_TOKEN_ID } from "../src/prebrain/hubspot-notes.js";

const cases = [
  { tokenId: FIGMA_TOKEN_ID, disconnect: disconnectFigma, label: "Figma" },
  { tokenId: DATADOG_TOKEN_ID, disconnect: disconnectDatadog, label: "Datadog" },
  { tokenId: GITLAB_TOKEN_ID, disconnect: disconnectGitlabThreads, label: "GitLab" },
  { tokenId: HUBSPOT_TOKEN_ID, disconnect: disconnectHubspot, label: "HubSpot" },
];

let testConfigDir: string;
let logs: string[];
let originalLog: typeof console.log;

beforeEach(() => {
  testConfigDir = mkdtempSync(join(tmpdir(), "gnt-disconnect-tokens-test-"));
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

for (const { tokenId, disconnect, label } of cases) {
  test(`disconnect ${label} removes the saved connection and reports it removed`, async () => {
    saveMcpToken(tokenId, `${tokenId}-secret`);

    await disconnect();

    expect(loadMcpToken(tokenId)).toBeUndefined();
    expect(logs.join("\n")).toContain(`Disconnected ${label}`);
  });

  test(`disconnect ${label} is a no-op, not an error, when nothing was ever connected`, async () => {
    await disconnect();

    expect(logs.join("\n")).toContain(`No stored ${label} connection`);
  });
}

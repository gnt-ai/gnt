// Same GNT_CONFIG_DIR-before-import pattern as test/gaps.test.ts -- avoids
// touching a real user's actual ~/.gnt/credentials.json.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testConfigDir = mkdtempSync(join(tmpdir(), "gnt-status-test-"));
process.env.GNT_CONFIG_DIR = testConfigDir;

const { saveApiKey, saveMcpToken, deleteMcpToken } = await import("../src/credentials.js");
const { status } = await import("../src/commands/status.js");
const { AIRTABLE_TOKEN_ID, serializeAirtableConfig } = await import("../src/prebrain/airtable.js");

const credentialsPath = join(testConfigDir, "credentials.json");

const SUMMARY_BODY = { pack_version: 3, slack_connected: true, mcp_key_exists: true };
const ROI_BODY = {
  window_days: 7,
  rules_served: 42,
  rules_served_prior: 30,
  actions_checked: 10,
  actions_checked_prior: 10,
  actions_blocked: 2,
  actions_blocked_prior: 5,
  actions_needs_human: 1,
  actions_needs_human_prior: 1,
  gap_count: 3,
  gap_count_prior: 8,
  stale_due_count: 0,
};

let originalFetch: typeof fetch;
let logs: string[];
let originalLog: typeof console.log;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  saveApiKey("gnt_live_test_key", "key-id");
  deleteMcpToken(AIRTABLE_TOKEN_ID);
  logs = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  rmSync(credentialsPath, { force: true });
  deleteMcpToken(AIRTABLE_TOKEN_ID);
});

function mockFetchByUrl(bodies: Record<string, unknown>, status = 200) {
  return mock((url: string) => {
    for (const [needle, body] of Object.entries(bodies)) {
      if (url.includes(needle)) {
        return Promise.resolve(new Response(JSON.stringify(body), { status }));
      }
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as unknown as typeof fetch;
}

test("prints ROI numbers with a week-over-week delta", async () => {
  globalThis.fetch = mockFetchByUrl({
    "/v1/brain/summary": SUMMARY_BODY,
    "/v1/billing/status": { entitled: true, subscription_status: "active", trial_ends_at: null },
    "/v1/onboarding/status": { connected_github: true, rules_approved: 5, rules_proposed: 6 },
    "/v1/rules/staleness/due": { count: 0, rules: [] },
    "/v1/roi/summary": ROI_BODY,
  });

  await status();

  const output = logs.join("\n");
  expect(output).toContain("Rules served (7d):");
  expect(output).toContain("42");
  expect(output).toContain("+12 vs. last week");
  expect(output).toContain("Actions checked (7d):");
  expect(output).toContain("flat vs. last week");
  expect(output).toContain("blocked:");
  expect(output).toContain("-3 vs. last week");
  expect(output).toContain("Coverage gaps (7d):");
  expect(output).toContain("-5 vs. last week");
});

test("omits the ROI section, not the rest of the command, when /v1/roi/summary fails", async () => {
  globalThis.fetch = mock((url: string) => {
    if (url.includes("/v1/roi/summary")) {
      return Promise.resolve(new Response("", { status: 500 }));
    }
    if (url.includes("/v1/brain/summary")) {
      return Promise.resolve(new Response(JSON.stringify(SUMMARY_BODY), { status: 200 }));
    }
    // billing/onboarding/staleness aren't this test's concern -- an empty
    // 200 body is enough for their own best-effort try/catch to no-op.
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  }) as unknown as typeof fetch;

  await status();

  const output = logs.join("\n");
  expect(output).toContain("Skill pack version:");
  expect(output).not.toContain("Rules served");
  expect(output).not.toContain("Coverage gaps");
});

// Airtable health line: every connector is expected to show a health line
// in `gnt status`. Airtable is a direct-REST connector, so this doesn't
// come from mcpConnectorHealth() the way an MCP-in adapter's line would
// (see status.ts's own comment on that call). Read straight from the
// local token store, same as every other connector's line, so no fetch
// mock is involved here. Matched with a regex, not toContain, because
// keyValueLines pads every label to the widest one on the page -- Notion/
// monday.com/etc.'s "X (MCP) connected" labels are longer than
// "Airtable connected", so the gap before the value is never exactly one
// space.
test("Airtable connected: no, when gnt connect airtable was never run", async () => {
  globalThis.fetch = mockFetchByUrl({ "/v1/brain/summary": SUMMARY_BODY });

  await status();

  const output = logs.join("\n");
  expect(output).toMatch(/Airtable connected:\s+no/);
});

test("Airtable connected: yes, once gnt connect airtable has saved a base and at least one table", async () => {
  globalThis.fetch = mockFetchByUrl({ "/v1/brain/summary": SUMMARY_BODY });
  saveMcpToken(
    AIRTABLE_TOKEN_ID,
    serializeAirtableConfig({
      token: "airtable-pat-secret",
      baseId: "appBase123",
      baseName: "Support Playbook",
      tables: [{ tableId: "tblNotes", tableName: "Playbook", allowedFields: ["Notes"] }],
    }),
  );

  await status();

  const output = logs.join("\n");
  expect(output).toMatch(/Airtable connected:\s+yes/);
});

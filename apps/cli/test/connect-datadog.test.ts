// Tests the non-TTY parts of `gnt connect datadog` / `gnt disconnect datadog`.
// The masked/plain keypress readers need a real terminal, so — same as
// connect-airtable.test.ts — this file covers resolve → validate → save and
// the disconnect path directly instead of driving keypresses.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disconnectDatadog } from "../src/commands/connect-datadog.js";
import { loadMcpToken, saveMcpToken } from "../src/credentials.js";
import {
  DATADOG_TOKEN_ID,
  DEFAULT_DATADOG_SITE,
  DatadogApiError,
  resolveDatadogCredentials,
  serializeDatadogCredentials,
  validateDatadogCredentials,
} from "../src/prebrain/datadog-notebooks.js";

let testConfigDir: string;
let logs: string[];
let originalLog: typeof console.log;
let originalApiKeyEnv: string | undefined;
let originalAppKeyEnv: string | undefined;
let originalSiteEnv: string | undefined;

beforeEach(() => {
  testConfigDir = mkdtempSync(join(tmpdir(), "gnt-connect-datadog-test-"));
  process.env.GNT_CONFIG_DIR = testConfigDir;
  originalApiKeyEnv = process.env.GNT_DATADOG_API_KEY;
  originalAppKeyEnv = process.env.GNT_DATADOG_APP_KEY;
  originalSiteEnv = process.env.GNT_DATADOG_SITE;
  delete process.env.GNT_DATADOG_API_KEY;
  delete process.env.GNT_DATADOG_APP_KEY;
  delete process.env.GNT_DATADOG_SITE;
  logs = [];
  originalLog = console.log;
  console.log = mock((...args: unknown[]) => {
    logs.push(args.join(" "));
  });
});

afterEach(() => {
  console.log = originalLog;
  rmSync(testConfigDir, { recursive: true, force: true });
  delete process.env.GNT_CONFIG_DIR;
  if (originalApiKeyEnv === undefined) delete process.env.GNT_DATADOG_API_KEY;
  else process.env.GNT_DATADOG_API_KEY = originalApiKeyEnv;
  if (originalAppKeyEnv === undefined) delete process.env.GNT_DATADOG_APP_KEY;
  else process.env.GNT_DATADOG_APP_KEY = originalAppKeyEnv;
  if (originalSiteEnv === undefined) delete process.env.GNT_DATADOG_SITE;
  else process.env.GNT_DATADOG_SITE = originalSiteEnv;
});

test("successful save with default site after validate passes", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;

  const creds = resolveDatadogCredentials({
    apiKey: "dd-api-key",
    appKey: "dd-app-key",
  });
  expect(creds.site).toBe(DEFAULT_DATADOG_SITE);

  await validateDatadogCredentials(creds, fetchImpl);
  saveMcpToken(DATADOG_TOKEN_ID, serializeDatadogCredentials(creds));

  const stored = loadMcpToken(DATADOG_TOKEN_ID);
  expect(stored).toBeDefined();
  expect(JSON.parse(stored!)).toEqual({
    apiKey: "dd-api-key",
    appKey: "dd-app-key",
    site: "datadoghq.com",
  });
});

test("successful save with a custom site override", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    expect(url).toContain("https://api.datadoghq.eu/");
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const creds = resolveDatadogCredentials({
    apiKey: "dd-api-key",
    appKey: "dd-app-key",
    site: "datadoghq.eu",
  });
  expect(creds.site).toBe("datadoghq.eu");

  await validateDatadogCredentials(creds, fetchImpl);
  saveMcpToken(DATADOG_TOKEN_ID, serializeDatadogCredentials(creds));

  expect(JSON.parse(loadMcpToken(DATADOG_TOKEN_ID)!).site).toBe("datadoghq.eu");
});

test("validation failure leaves nothing saved", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ errors: ["Forbidden"] }), { status: 403 })) as unknown as typeof fetch;

  const creds = resolveDatadogCredentials({
    apiKey: "bad-api-key",
    appKey: "bad-app-key",
  });

  await expect(validateDatadogCredentials(creds, fetchImpl)).rejects.toBeInstanceOf(DatadogApiError);
  expect(loadMcpToken(DATADOG_TOKEN_ID)).toBeUndefined();
});

test("disconnectDatadog removes a saved connection and reports it removed", async () => {
  saveMcpToken(
    DATADOG_TOKEN_ID,
    serializeDatadogCredentials({
      apiKey: "dd-api-key",
      appKey: "dd-app-key",
      site: "datadoghq.com",
    }),
  );

  await disconnectDatadog();

  expect(loadMcpToken(DATADOG_TOKEN_ID)).toBeUndefined();
  expect(logs.join("\n")).toContain("Disconnected Datadog");
});

test("disconnectDatadog is a no-op when nothing was connected", async () => {
  await disconnectDatadog();

  expect(logs.join("\n")).toContain("No stored Datadog connection to remove.");
});

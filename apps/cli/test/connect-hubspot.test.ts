// Tests the non-TTY parts of `gnt connect hubspot` / `gnt disconnect hubspot`.
// The masked keypress reader needs a real terminal, so -- same as
// connect-datadog.test.ts -- this file covers resolve -> validate -> save and
// the disconnect path directly instead of driving keypresses.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disconnectHubspot } from "../src/commands/connect-hubspot.js";
import { loadMcpToken, saveMcpToken } from "../src/credentials.js";
import {
  HUBSPOT_API_BASE,
  HUBSPOT_TOKEN_ID,
  HubspotApiError,
  MissingHubspotTokenError,
  resolveHubspotToken,
  validateHubspotToken,
} from "../src/prebrain/hubspot-notes.js";

let testConfigDir: string;
let logs: string[];
let originalLog: typeof console.log;
let originalTokenEnv: string | undefined;

beforeEach(() => {
  testConfigDir = mkdtempSync(join(tmpdir(), "gnt-connect-hubspot-test-"));
  process.env.GNT_CONFIG_DIR = testConfigDir;
  originalTokenEnv = process.env.GNT_HUBSPOT_TOKEN;
  delete process.env.GNT_HUBSPOT_TOKEN;
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
  if (originalTokenEnv === undefined) delete process.env.GNT_HUBSPOT_TOKEN;
  else process.env.GNT_HUBSPOT_TOKEN = originalTokenEnv;
});

test("successful save after validation passes", async () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    expect(url).toContain(`${HUBSPOT_API_BASE}/crm/v3/owners?limit=1`);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer pat-test-token");
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const token = resolveHubspotToken("pat-test-token", undefined);
  expect(token).toBe("pat-test-token");

  await validateHubspotToken(token, fetchImpl);
  saveMcpToken(HUBSPOT_TOKEN_ID, token);

  const stored = loadMcpToken(HUBSPOT_TOKEN_ID);
  expect(stored).toBe("pat-test-token");
});

test("token resolves from GNT_HUBSPOT_TOKEN when not passed directly", () => {
  process.env.GNT_HUBSPOT_TOKEN = "pat-env-token";
  const token = resolveHubspotToken(undefined, undefined);
  expect(token).toBe("pat-env-token");
});

test("stored token is used when neither explicit nor env is provided", () => {
  const token = resolveHubspotToken(undefined, "pat-stored-token");
  expect(token).toBe("pat-stored-token");
});

test("resolve throws when no token is available anywhere", () => {
  expect(() => resolveHubspotToken(undefined, undefined)).toThrow(MissingHubspotTokenError);
});

test("validation failure leaves nothing saved", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ status: "error", message: "unauthorized" }), { status: 401 })) as unknown as typeof fetch;

  await expect(validateHubspotToken("bad-token", fetchImpl)).rejects.toBeInstanceOf(HubspotApiError);
  expect(loadMcpToken(HUBSPOT_TOKEN_ID)).toBeUndefined();
});

test("disconnectHubspot removes a saved connection and reports it removed", async () => {
  saveMcpToken(HUBSPOT_TOKEN_ID, "pat-test-token");

  await disconnectHubspot();

  expect(loadMcpToken(HUBSPOT_TOKEN_ID)).toBeUndefined();
  expect(logs.join("\n")).toContain("Disconnected HubSpot");
});

test("disconnectHubspot is a no-op when nothing was connected", async () => {
  await disconnectHubspot();

  expect(logs.join("\n")).toContain("No stored HubSpot connection to remove.");
});

// Tests the non-TTY parts of `gnt connect figma` / `gnt disconnect figma`.
// The masked keypress reader needs a real terminal, so -- same as
// connect-datadog.test.ts -- this file covers resolve -> validate -> save and
// the disconnect path directly instead of driving keypresses.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disconnectFigma } from "../src/commands/connect-figma.js";
import { loadMcpToken, saveMcpToken } from "../src/credentials.js";
import {
  FIGMA_API_BASE,
  FIGMA_TOKEN_ID,
  FigmaApiError,
  MissingFigmaTokenError,
  resolveFigmaToken,
  validateFigmaToken,
} from "../src/prebrain/figma-comments.js";

let testConfigDir: string;
let logs: string[];
let originalLog: typeof console.log;
let originalTokenEnv: string | undefined;

beforeEach(() => {
  testConfigDir = mkdtempSync(join(tmpdir(), "gnt-connect-figma-test-"));
  process.env.GNT_CONFIG_DIR = testConfigDir;
  originalTokenEnv = process.env.GNT_FIGMA_TOKEN;
  delete process.env.GNT_FIGMA_TOKEN;
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
  if (originalTokenEnv === undefined) delete process.env.GNT_FIGMA_TOKEN;
  else process.env.GNT_FIGMA_TOKEN = originalTokenEnv;
});

test("successful save after validation passes", async () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    expect(url).toContain(`${FIGMA_API_BASE}/v1/me`);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["X-Figma-Token"]).toBe("figd-test-token");
    return new Response(JSON.stringify({ id: "123", handle: "test-user" }), { status: 200 });
  }) as unknown as typeof fetch;

  const token = resolveFigmaToken("figd-test-token", undefined);
  expect(token).toBe("figd-test-token");

  await validateFigmaToken(token, fetchImpl);
  saveMcpToken(FIGMA_TOKEN_ID, token);

  const stored = loadMcpToken(FIGMA_TOKEN_ID);
  expect(stored).toBe("figd-test-token");
});

test("token resolves from GNT_FIGMA_TOKEN when not passed directly", () => {
  process.env.GNT_FIGMA_TOKEN = "figd-env-token";
  const token = resolveFigmaToken(undefined, undefined);
  expect(token).toBe("figd-env-token");
});

test("stored token is used when neither explicit nor env is provided", () => {
  const token = resolveFigmaToken(undefined, "figd-stored-token");
  expect(token).toBe("figd-stored-token");
});

test("resolve throws when no token is available anywhere", () => {
  expect(() => resolveFigmaToken(undefined, undefined)).toThrow(MissingFigmaTokenError);
});

test("validation failure leaves nothing saved", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ err: "Invalid token" }), { status: 403 })) as unknown as typeof fetch;

  await expect(validateFigmaToken("bad-token", fetchImpl)).rejects.toBeInstanceOf(FigmaApiError);
  expect(loadMcpToken(FIGMA_TOKEN_ID)).toBeUndefined();
});

test("disconnectFigma removes a saved connection and reports it removed", async () => {
  saveMcpToken(FIGMA_TOKEN_ID, "figd-test-token");

  await disconnectFigma();

  expect(loadMcpToken(FIGMA_TOKEN_ID)).toBeUndefined();
  expect(logs.join("\n")).toContain("Disconnected Figma");
});

test("disconnectFigma is a no-op when nothing was connected", async () => {
  await disconnectFigma();

  expect(logs.join("\n")).toContain("No stored Figma connection to remove.");
});

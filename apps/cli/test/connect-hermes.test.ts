// Tests `gnt connect hermes` (commands/connect-hermes.ts): the interactive
// config-write flow that hermes-config.test.ts deliberately does not cover.
// HERMES_DIR / HERMES_CONFIG_PATH are hardcoded to ~/.hermes at module load
// (no GNT_CONFIG_DIR-style override), so this file mocks hermes-config.js's
// path exports to a temp dir — same mock.module precedent connect-github
// and org.test.ts already set for other frozen-at-import values.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realReadline from "node:readline";

const testConfigDir = mkdtempSync(join(tmpdir(), "gnt-connect-hermes-creds-"));
const fakeHome = mkdtempSync(join(tmpdir(), "gnt-connect-hermes-home-"));
const hermesDir = join(fakeHome, ".hermes");
const hermesConfigPath = join(hermesDir, "config.yaml");
const previousConfigDir = process.env.GNT_CONFIG_DIR;
process.env.GNT_CONFIG_DIR = testConfigDir;

const realHermesConfig = await import("../src/hermes-config.js");
mock.module("../src/hermes-config.js", () => ({
  ...realHermesConfig,
  HERMES_DIR: hermesDir,
  HERMES_CONFIG_PATH: hermesConfigPath,
}));

let promptAnswers: string[] = [];
let useReadlineMock = false;

mock.module("node:readline", () => ({
  ...realReadline,
  createInterface: (opts: Parameters<typeof realReadline.createInterface>[0]) => {
    if (!useReadlineMock) {
      return realReadline.createInterface(opts);
    }
    return {
      question: (_prompt: string, cb: (answer: string) => void) => {
        cb(promptAnswers.shift() ?? "");
      },
      close: () => {},
    };
  },
}));

const { saveApiKey } = await import("../src/credentials.js");
const { GNT_KEY_ENV_VAR } = await import("../src/hermes-config.js");
const { connectHermes } = await import("../src/commands/connect-hermes.js");

if (previousConfigDir === undefined) {
  delete process.env.GNT_CONFIG_DIR;
} else {
  process.env.GNT_CONFIG_DIR = previousConfigDir;
}

// eslint-disable-next-line no-control-regex -- strips terminal ANSI color sequences before assertions.
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_PATTERN, "");
}

let originalFetch: typeof fetch;
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalExit: typeof process.exit;
let originalStdinIsTTY: boolean | undefined;
let logs: string[];
let errors: string[];
let exitCalls: number[];

function output(): string {
  return stripAnsi(logs.join("\n"));
}

function errorOutput(): string {
  return stripAnsi(errors.join("\n"));
}

function mockFetch(body: unknown, status = 200) {
  const fetchMock = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function cleanHermesHome(): void {
  rmSync(hermesDir, { recursive: true, force: true });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalLog = console.log;
  originalError = console.error;
  originalExit = process.exit;
  originalStdinIsTTY = process.stdin.isTTY;

  process.env.GNT_CONFIG_DIR = testConfigDir;
  saveApiKey("gnt_live_test_key", "key-id");
  cleanHermesHome();

  logs = [];
  errors = [];
  exitCalls = [];
  promptAnswers = [];
  useReadlineMock = true;

  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  process.exit = ((code?: number | string) => {
    exitCalls.push(Number(code));
    throw new Error("process.exit called");
  }) as unknown as typeof process.exit;

  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  Object.defineProperty(process.stdin, "isTTY", { value: originalStdinIsTTY, configurable: true });
  useReadlineMock = false;
  promptAnswers = [];
  cleanHermesHome();
  rmSync(join(testConfigDir, "credentials.json"), { force: true });

  if (previousConfigDir === undefined) {
    delete process.env.GNT_CONFIG_DIR;
  } else {
    process.env.GNT_CONFIG_DIR = previousConfigDir;
  }
});

test("exits when ~/.hermes is missing, without creating anything under the fake home", async () => {
  await expect(connectHermes()).rejects.toThrow("process.exit called");

  expect(exitCalls).toEqual([1]);
  expect(errorOutput()).toContain("No local Hermes install found");
  expect(errorOutput()).toContain("https://hermes-agent.nousresearch.com/docs/getting-started/installation");
  expect(existsSync(hermesDir)).toBe(false);
  expect(existsSync(join(fakeHome, ".hermes"))).toBe(false);
});

test("short-circuits when mcp_servers.gnt already exists, leaving the file and no .bak", async () => {
  mkdirSync(hermesDir, { recursive: true });
  const existing = ['mcp_servers:', '  gnt:', '    url: "https://example.com/mcp"', ""].join("\n");
  writeFileSync(hermesConfigPath, existing);

  await connectHermes();

  expect(output()).toContain("already configured");
  expect(output()).toContain("mcp_servers.gnt");
  expect(readFileSync(hermesConfigPath, "utf-8")).toBe(existing);
  expect(existsSync(`${hermesConfigPath}.bak`)).toBe(false);
});

test("declined consent prints Nothing written and leaves a present config untouched", async () => {
  mkdirSync(hermesDir, { recursive: true });
  const existing = 'model:\n  name: "x"\n';
  writeFileSync(hermesConfigPath, existing);
  promptAnswers = ["n"];

  await connectHermes();

  expect(output()).toContain("Nothing written");
  expect(readFileSync(hermesConfigPath, "utf-8")).toBe(existing);
  expect(existsSync(`${hermesConfigPath}.bak`)).toBe(false);
});

test("declined consent with no config file yet still writes nothing", async () => {
  mkdirSync(hermesDir, { recursive: true });
  promptAnswers = ["no"];

  await connectHermes();

  expect(output()).toContain("Nothing written");
  expect(existsSync(hermesConfigPath)).toBe(false);
});

test("fresh install: consent + successful mint writes config, no .bak, prints the key and export hint", async () => {
  mkdirSync(hermesDir, { recursive: true });
  promptAnswers = ["y"];
  mockFetch({ key: "gnt_mcp_minted_abc" });

  await connectHermes();

  expect(existsSync(hermesConfigPath)).toBe(true);
  expect(existsSync(`${hermesConfigPath}.bak`)).toBe(false);
  const written = readFileSync(hermesConfigPath, "utf-8");
  expect(written).toContain("mcp_servers:");
  expect(written).toContain("  gnt:");
  expect(written).toContain(`\${${GNT_KEY_ENV_VAR}}`);
  expect(output()).toContain("Connected");
  expect(output()).toContain("gnt_mcp_minted_abc");
  expect(output()).toContain(`Export ${GNT_KEY_ENV_VAR}=gnt_mcp_minted_abc`);
});

test("existing config without gnt: consent writes a .bak with the original content", async () => {
  mkdirSync(hermesDir, { recursive: true });
  const existing = 'model:\n  name: "kept"\n';
  writeFileSync(hermesConfigPath, existing);
  promptAnswers = ["yes"];
  mockFetch({ key: "gnt_mcp_minted_xyz" });

  await connectHermes();

  expect(existsSync(`${hermesConfigPath}.bak`)).toBe(true);
  expect(readFileSync(`${hermesConfigPath}.bak`, "utf-8")).toBe(existing);
  const written = readFileSync(hermesConfigPath, "utf-8");
  expect(written).toContain('name: "kept"');
  expect(written).toContain("  gnt:");
  expect(output()).toContain("backup of the previous config");
});

test("mintKey network failure still leaves the written config and falls back to gnt keys create hint", async () => {
  mkdirSync(hermesDir, { recursive: true });
  promptAnswers = ["y"];
  globalThis.fetch = mock(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;

  await connectHermes();

  expect(existsSync(hermesConfigPath)).toBe(true);
  expect(readFileSync(hermesConfigPath, "utf-8")).toContain("  gnt:");
  expect(output()).toContain("Couldn't reach");
  expect(output()).toContain("Run `gnt keys create`");
  expect(output()).not.toContain("MCP key:");
});

test("mintKey non-ok response still leaves the written config and falls back to gnt keys create hint", async () => {
  mkdirSync(hermesDir, { recursive: true });
  promptAnswers = ["y"];
  mockFetch({ detail: "nope" }, 500);

  await connectHermes();

  expect(existsSync(hermesConfigPath)).toBe(true);
  expect(output()).toContain("Couldn't mint an MCP key (500)");
  expect(output()).toContain("Run `gnt keys create`");
});

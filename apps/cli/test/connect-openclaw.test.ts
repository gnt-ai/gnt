// Tests `gnt connect openclaw` (commands/connect-openclaw.ts): consent,
// mint, live-validate, and write paths against a third-party config file.
// OPENCLAW_CONFIG_PATH is frozen to join(homedir(), ".openclaw/openclaw.json")
// at module load, so this file mocks node:os.homedir to a temp dir for that
// import only (then restores real homedir for the rest of the bun test
// process). The MCP SDK client/transport are also mocked — first time this
// repo's suite has done that.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as realOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realReadline from "node:readline";

const testConfigDir = mkdtempSync(join(tmpdir(), "gnt-connect-openclaw-creds-"));
const fakeHome = mkdtempSync(join(tmpdir(), "gnt-connect-openclaw-home-"));
const openclawDir = join(fakeHome, ".openclaw");
const openclawConfigPath = join(openclawDir, "openclaw.json");
const previousConfigDir = process.env.GNT_CONFIG_DIR;
process.env.GNT_CONFIG_DIR = testConfigDir;

// Bake OPENCLAW_CONFIG_PATH against fakeHome at connect-openclaw import time,
// then flip this off so later-loaded modules still see the real homedir.
let useFakeHomedir = true;
mock.module("node:os", () => ({
  ...realOs,
  homedir: () => (useFakeHomedir ? fakeHome : realOs.homedir()),
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

let liveValidationShouldFail = false;
let liveValidationCalls = 0;

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {
      liveValidationCalls += 1;
      if (liveValidationShouldFail) {
        throw new Error("connection refused");
      }
    }
    async listTools() {
      if (liveValidationShouldFail) {
        throw new Error("connection refused");
      }
      return { tools: [] };
    }
    async close() {}
  },
}));

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(..._args: unknown[]) {
      void _args;
    }
  },
}));
const { saveApiKey } = await import("../src/credentials.js");
const { MCP_URL } = await import("../src/config.js");
const { connectOpenclaw } = await import("../src/commands/connect-openclaw.js");

// Path is baked into the command module now — restore real homedir for peers.
useFakeHomedir = false;

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
let logs: string[];
let errors: string[];
let fetchCalls: Array<{ input: string; init?: RequestInit }>;

function output(): string {
  return stripAnsi(logs.join("\n"));
}

function errorOutput(): string {
  return stripAnsi(errors.join("\n"));
}

function mockFetch(body: unknown, status = 200) {
  const fetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ input: String(input), init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function cleanOpenclawHome(): void {
  rmSync(openclawDir, { recursive: true, force: true });
}

function writeOpenclawConfig(value: unknown): void {
  mkdirSync(openclawDir, { recursive: true });
  writeFileSync(openclawConfigPath, `${JSON.stringify(value, null, 2)}\n`);
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Reject by default so paths that shouldn't mint can't leak a real network call.
  globalThis.fetch = mock(() => Promise.reject(new Error("Unexpected fetch"))) as unknown as typeof fetch;
  originalLog = console.log;
  originalError = console.error;
  originalExit = process.exit;

  process.env.GNT_CONFIG_DIR = testConfigDir;
  // Default: logged in. Individual tests clear credentials when needed.
  saveApiKey("gnt_live_test_key", "key-id");
  cleanOpenclawHome();

  logs = [];
  errors = [];
  fetchCalls = [];
  promptAnswers = [];
  useReadlineMock = true;
  liveValidationShouldFail = false;
  liveValidationCalls = 0;

  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  process.exit = ((code?: number | string) => {
    throw new Error(`process.exit called with ${code}`);
  }) as unknown as typeof process.exit;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  useReadlineMock = false;
  promptAnswers = [];
  cleanOpenclawHome();
  rmSync(testConfigDir, { recursive: true, force: true });

  if (previousConfigDir === undefined) {
    delete process.env.GNT_CONFIG_DIR;
  } else {
    process.env.GNT_CONFIG_DIR = previousConfigDir;
  }
});

test("missing config prints the manual JSON block and writes nothing", async () => {
  await connectOpenclaw();

  expect(output()).toContain("No local OpenClaw install detected");
  expect(output()).toContain("gnt-brain");
  expect(output()).toContain(MCP_URL);
  expect(output()).toContain("mcp");
  expect(existsSync(openclawConfigPath)).toBe(false);
});

test("malformed JSON falls back to the manual block and leaves the broken file untouched", async () => {
  mkdirSync(openclawDir, { recursive: true });
  const broken = '{\n  // comment\n  "mcp": {}\n}\n';
  writeFileSync(openclawConfigPath, broken);

  await connectOpenclaw();

  expect(output()).toContain("isn't strict JSON");
  expect(output()).toContain("gnt-brain");
  expect(readFileSync(openclawConfigPath, "utf-8")).toBe(broken);
});

test("existing gnt-brain entry reports already configured and does not write", async () => {
  writeOpenclawConfig({
    mcp: {
      servers: {
        "gnt-brain": { url: "https://example.com/mcp/" },
      },
    },
  });
  const before = readFileSync(openclawConfigPath, "utf-8");

  await connectOpenclaw();

  expect(output()).toContain("already configured");
  expect(output()).toContain("gnt-brain");
  expect(readFileSync(openclawConfigPath, "utf-8")).toBe(before);
  expect(fetchCalls).toHaveLength(0);
});

test("no local credentials: mintKey returns without prompting or fetch; falls through to existing-key ask", async () => {
  writeOpenclawConfig({ other: true });
  const before = readFileSync(openclawConfigPath, "utf-8");
  rmSync(join(testConfigDir, "credentials.json"), { force: true });
  // Decline "already have a key?" then decline the final write confirm.
  // Both prompts go through readline (not console.log), so we assert on
  // the no-fetch + unchanged-file side effects rather than the prompt text.
  promptAnswers = ["n", "n"];

  await connectOpenclaw();

  expect(fetchCalls).toHaveLength(0);
  expect(liveValidationCalls).toBe(0);
  expect(output()).toContain("Found an OpenClaw install");
  expect(output()).toContain("Nothing written");
  // Raw bytes, not parsed equality — a rewrite of equivalent JSON would still fail.
  expect(readFileSync(openclawConfigPath, "utf-8")).toBe(before);
});

test("happy path: mint + live validate + write merges gnt-brain and prints the minted success hint", async () => {
  writeOpenclawConfig({
    gateway: { port: 18789 },
    mcp: { servers: { other: { url: "https://other.example/" } } },
  });
  // mint confirm, final write confirm
  promptAnswers = ["y", "y"];
  mockFetch({ key: "gnt_mcp_openclaw_1" });

  await connectOpenclaw();

  expect(liveValidationCalls).toBe(1);
  expect(fetchCalls).toHaveLength(1);
  expect(String(fetchCalls[0]?.input)).toContain("/v1/settings/mcp-keys");
  expect(fetchCalls[0]?.init?.body).toBe(JSON.stringify({ name: "openclaw" }));

  const written = JSON.parse(readFileSync(openclawConfigPath, "utf-8")) as {
    gateway: { port: number };
    mcp: { servers: Record<string, { url: string; transport: string; headers: { Authorization: string } }> };
  };
  expect(written.gateway.port).toBe(18789);
  expect(written.mcp.servers.other).toEqual({ url: "https://other.example/" });
  expect(written.mcp.servers["gnt-brain"]).toEqual({
    url: MCP_URL,
    transport: "streamable-http",
    headers: { Authorization: "Bearer ${GNT_MCP_KEY}" },
  });

  expect(output()).toContain("Minted an MCP key");
  expect(output()).toContain("gnt_mcp_openclaw_1");
  expect(output()).toContain('Added "gnt-brain"');
  expect(output()).toContain("Export GNT_MCP_KEY=<the key printed above>");
});

test("live validation failure writes nothing and prints the manual block", async () => {
  writeOpenclawConfig({ mcp: { servers: {} } });
  const before = readFileSync(openclawConfigPath, "utf-8");
  promptAnswers = ["y"];
  mockFetch({ key: "gnt_mcp_bad" });
  liveValidationShouldFail = true;

  await connectOpenclaw();

  expect(liveValidationCalls).toBe(1);
  expect(errorOutput()).toContain("Couldn't reach gnt's MCP endpoint");
  expect(output()).toContain("Nothing written");
  expect(output()).toContain("gnt-brain");
  expect(readFileSync(openclawConfigPath, "utf-8")).toBe(before);
});

test("final write declined prints Nothing written even after a successful mint and validate", async () => {
  writeOpenclawConfig({ mcp: { servers: {} } });
  const before = readFileSync(openclawConfigPath, "utf-8");
  // mint confirm, final write decline
  promptAnswers = ["y", "n"];
  mockFetch({ key: "gnt_mcp_unused" });

  await connectOpenclaw();

  expect(liveValidationCalls).toBe(1);
  expect(output()).toContain("Connected to gnt's MCP endpoint");
  expect(output()).toContain("Nothing written");
  expect(readFileSync(openclawConfigPath, "utf-8")).toBe(before);
});

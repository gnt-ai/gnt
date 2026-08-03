// Set a temporary config directory before importing the command modules so
// this file never reads or writes a user's real ~/.gnt/credentials.json.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testConfigDir = mkdtempSync(join(tmpdir(), "gnt-pull-test-"));
const previousConfigDir = process.env.GNT_CONFIG_DIR;
process.env.GNT_CONFIG_DIR = testConfigDir;

const { saveApiKey } = await import("../src/credentials.js");
const { pull } = await import("../src/commands/pull.js");

if (previousConfigDir === undefined) {
  delete process.env.GNT_CONFIG_DIR;
} else {
  process.env.GNT_CONFIG_DIR = previousConfigDir;
}

const credentialsPath = join(testConfigDir, "credentials.json");

let originalFetch: typeof fetch;
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalExit: typeof process.exit;
let originalCwd: string;
let workDir: string;

let logs: string[];
let errors: string[];
let exitCalls: number[];

// eslint-disable-next-line no-control-regex -- strips terminal ANSI color sequences before assertions.
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

function output() {
  return logs.join("\n").replace(ANSI_ESCAPE_PATTERN, "");
}

function errorOutput() {
  return errors.join("\n").replace(ANSI_ESCAPE_PATTERN, "");
}

function mockZipResponse(opts: {
  status?: number;
  body?: Uint8Array | string;
  contentDisposition?: string | null;
}) {
  const status = opts.status ?? 200;
  const body = opts.body ?? new Uint8Array([1, 2, 3, 4]);
  const headers = new Headers();
  if (opts.contentDisposition !== null) {
    headers.set(
      "Content-Disposition",
      // Match the API's unquoted form (skill_packs.py): filename=gnt-pack-v{n}.zip
      opts.contentDisposition ?? "attachment; filename=gnt-pack-v3.zip",
    );
  }
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(body, { status, headers })),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalLog = console.log;
  originalError = console.error;
  originalExit = process.exit;
  originalCwd = process.cwd();

  process.env.GNT_CONFIG_DIR = testConfigDir;
  saveApiKey("gnt_live_test_key", "key-id");

  workDir = mkdtempSync(join(tmpdir(), "gnt-pull-cwd-"));
  process.chdir(workDir);

  logs = [];
  errors = [];
  exitCalls = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };

  process.exit = ((code?: number | string) => {
    exitCalls.push(Number(code));
    throw new Error("test process exit");
  }) as unknown as typeof process.exit;
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });

  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;

  rmSync(credentialsPath, { force: true });

  if (previousConfigDir === undefined) {
    delete process.env.GNT_CONFIG_DIR;
  } else {
    process.env.GNT_CONFIG_DIR = previousConfigDir;
  }
});

test("prints No skill pack yet on 404 without exiting", async () => {
  mockZipResponse({ status: 404, body: "" });

  await pull();

  expect(output()).toContain("No skill pack yet.");
  expect(exitCalls).toEqual([]);
  expect(existsSync(join(workDir, "gnt-pack.zip"))).toBe(false);
});

test("prints an error and exits on a non-ok, non-404 response", async () => {
  mockZipResponse({ status: 500, body: "" });

  await expect(pull()).rejects.toThrow("test process exit");

  expect(errorOutput()).toContain("Failed to download skill pack (500).");
  expect(exitCalls).toEqual([1]);
});

test("saves the zip under the Content-Disposition filename and reports size in B", async () => {
  const body = new Uint8Array(500).fill(7);
  mockZipResponse({
    body,
    contentDisposition: "attachment; filename=pack-small.zip",
  });

  await pull();

  const saved = join(workDir, "pack-small.zip");
  expect(existsSync(saved)).toBe(true);
  expect(readFileSync(saved)).toEqual(Buffer.from(body));
  expect(output()).toContain("Saved pack-small.zip (500B)");
});

test("reports KB for sizes between 1KB and 1MB", async () => {
  const body = new Uint8Array(2048).fill(1);
  mockZipResponse({
    body,
    contentDisposition: "attachment; filename=pack-kb.zip",
  });

  await pull();

  expect(output()).toContain("Saved pack-kb.zip (2.0KB)");
});

test("reports MB for sizes at or over 1MB", async () => {
  const body = new Uint8Array(1024 * 1024).fill(1);
  mockZipResponse({
    body,
    contentDisposition: "attachment; filename=pack-mb.zip",
  });

  await pull();

  expect(output()).toContain("Saved pack-mb.zip (1.0MB)");
});

test("strips path components from a traversal-shaped Content-Disposition filename", async () => {
  const body = new Uint8Array([9, 9, 9]);
  mockZipResponse({
    body,
    contentDisposition: "attachment; filename=../../etc/passwd",
  });

  await pull();

  expect(existsSync(join(workDir, "passwd"))).toBe(true);
  expect(existsSync(join(workDir, "etc"))).toBe(false);
  expect(readFileSync(join(workDir, "passwd"))).toEqual(Buffer.from(body));
  expect(output()).toContain("Saved passwd (3B)");
});

test("falls back to gnt-pack.zip when Content-Disposition is missing", async () => {
  const body = new Uint8Array([4, 5]);
  mockZipResponse({ body, contentDisposition: null });

  await pull();

  expect(existsSync(join(workDir, "gnt-pack.zip"))).toBe(true);
  expect(readFileSync(join(workDir, "gnt-pack.zip"))).toEqual(Buffer.from(body));
  expect(output()).toContain("Saved gnt-pack.zip (2B)");
});

test("falls back to gnt-pack.zip when Content-Disposition filename is '.'", async () => {
  const body = new Uint8Array([6]);
  mockZipResponse({ body, contentDisposition: "attachment; filename=." });

  await pull();

  expect(existsSync(join(workDir, "gnt-pack.zip"))).toBe(true);
  expect(output()).toContain("Saved gnt-pack.zip (1B)");
});

test("falls back to gnt-pack.zip when Content-Disposition filename is '..'", async () => {
  const body = new Uint8Array([7]);
  mockZipResponse({ body, contentDisposition: "attachment; filename=.." });

  await pull();

  expect(existsSync(join(workDir, "gnt-pack.zip"))).toBe(true);
  expect(output()).toContain("Saved gnt-pack.zip (1B)");
});

test("strips absolute path components from Content-Disposition before writing", async () => {
  const body = new Uint8Array([8]);
  mockZipResponse({
    body,
    contentDisposition: "attachment; filename=/tmp/evil.zip",
  });

  await pull();

  // Only the basename is used — never the raw /tmp/... path.
  expect(existsSync(join(workDir, "evil.zip"))).toBe(true);
  expect(existsSync(join(workDir, "tmp"))).toBe(false);
  expect(output()).toContain("Saved evil.zip (1B)");
});

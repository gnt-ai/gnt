// Tests `gnt connect github` (App flow) and `--pat` (legacy flow) against
// mocked fetch/open, same GNT_CONFIG_DIR-before-any-import + dynamic-import
// ordering trick disconnect-github.test.ts uses.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testConfigDir = mkdtempSync(join(tmpdir(), "gnt-connect-github-test-"));
process.env.GNT_CONFIG_DIR = testConfigDir;

mock.module("open", () => ({ default: mock(() => Promise.resolve()) }));

const { saveApiKey } = await import("../src/credentials.js");
const { connectGithub } = await import("../src/commands/connect-github.js");

let originalFetch: typeof fetch;
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalExit: typeof process.exit;
let originalWrite: typeof process.stdout.write;
let logs: string[];
let errors: string[];
let written: string[];

beforeEach(() => {
  saveApiKey("gnt_live_test_key", "11111111-1111-1111-1111-111111111111");
  originalFetch = globalThis.fetch;
  originalLog = console.log;
  originalError = console.error;
  originalExit = process.exit;
  originalWrite = process.stdout.write;
  logs = [];
  errors = [];
  written = [];
  console.log = mock((...args: unknown[]) => {
    logs.push(args.join(" "));
  });
  console.error = mock((...args: unknown[]) => {
    errors.push(args.join(" "));
  });
  process.exit = mock(() => {
    throw new Error("process.exit called");
  }) as unknown as typeof process.exit;
  // spinner() (theme.ts) writes straight to process.stdout in non-TTY mode
  // (which bun test always is) rather than console.log — its final status
  // line has to be captured here, not via the console.log mock above.
  process.stdout.write = mock((chunk: string) => {
    written.push(chunk);
    return true;
  }) as unknown as typeof process.stdout.write;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  process.stdout.write = originalWrite;
  rmSync(testConfigDir, { recursive: true, force: true });
});

test("opens the install URL and reports success once the connection shows up on poll", async () => {
  let pollCount = 0;
  const fetchMock = mock((url: string) => {
    if (url.includes("/app/install-url")) {
      return Promise.resolve(
        new Response(JSON.stringify({ url: "https://github.com/apps/gnt-ai-connector/installations/new?state=abc" }), {
          status: 200,
        }),
      );
    }
    // GET /v1/settings/github poll — not connected the first call, connected the second.
    pollCount += 1;
    const body =
      pollCount === 1
        ? { connected: false }
        : { connected: true, connection_type: "app", repo_url: "https://github.com/acme/rules", default_branch: "main" };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await connectGithub();

  expect(logs.join("\n")).toContain("https://github.com/apps/gnt-ai-connector/installations/new?state=abc");
  expect(written.join("")).toContain("Connected to https://github.com/acme/rules via the GitHub App");
});

test("exits non-zero when the install-url call fails", async () => {
  const fetchMock = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ detail: "the GitHub App isn't configured" }), { status: 502 })),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await expect(connectGithub()).rejects.toThrow("process.exit called");
  expect(errors.join("\n")).toContain("Failed to start the GitHub App install (502)");
});

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testConfigDir = mkdtempSync(join(tmpdir(), "gnt-doctor-credentials-"));
process.env.GNT_CONFIG_DIR = testConfigDir;

const { saveApiKey, clearCredentials } = await import("../src/credentials.js");
const { doctor, isSupportedNodeVersion } = await import("../src/commands/doctor.js");

let logs: string[];
let originalLog: typeof console.log;

beforeEach(() => {
  clearCredentials();
  logs = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
});

afterEach(() => {
  console.log = originalLog;
  clearCredentials();
});

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex -- test assertions compare visible CLI output
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function healthyFetch(connectedGithub = true): typeof fetch {
  return mock((url: string) => {
    if (url.endsWith("/healthz")) {
      return Promise.resolve(Response.json({ status: "ok" }));
    }
    if (url.endsWith("/v1/onboarding/status")) {
      return Promise.resolve(Response.json({ connected_github: connectedGithub }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as unknown as typeof fetch;
}

test("accepts the package's minimum Node version and newer releases", () => {
  expect(isSupportedNodeVersion("22.13.0")).toBe(true);
  expect(isSupportedNodeVersion("22.12.9")).toBe(false);
  expect(isSupportedNodeVersion("23.0.0")).toBe(true);
  expect(isSupportedNodeVersion("not-a-version")).toBe(false);
});

test("reports a healthy login, API, and connected rules repository in one pass", async () => {
  saveApiKey("gnt_live_test", "key-id");

  const result = await doctor({ cwd: tmpdir(), fetchImpl: healthyFetch(), nodeVersion: "22.13.0" });

  expect(result).toBe(true);
  const output = stripAnsi(logs.join("\n"));
  expect(output).toContain("Node 22.13.0");
  expect(output).toContain("Login credentials found");
  expect(output).toContain("API reachable");
  expect(output).toContain("GitHub rules repository connected");
  expect(output).toContain("No blocking problems found");
});

test("still runs every independent check when Node, login, and API checks fail", async () => {
  const fetchImpl = mock(() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;

  const result = await doctor({ cwd: tmpdir(), fetchImpl, nodeVersion: "20.18.0" });

  expect(result).toBe(false);
  const output = stripAnsi(logs.join("\n"));
  expect(output).toContain("Node 20.18.0 is unsupported");
  expect(output).toContain("Not logged in");
  expect(output).toContain("API unreachable");
  expect(output).toContain("repository check skipped");
});

test("identifies the documented self-host environment mistakes", async () => {
  const root = mkdtempSync(join(tmpdir(), "gnt-doctor-self-host-"));
  mkdirSync(join(root, "apps/api"), { recursive: true });
  mkdirSync(join(root, "apps/store"), { recursive: true });
  writeFileSync(join(root, "docker-compose.yml"), "services: {}\n");
  writeFileSync(join(root, "apps/api/.env.example"), "");
  writeFileSync(
    join(root, "apps/api/.env"),
    "CONTRIBUTOR_HASH_SECRET=change-me-to-a-random-secret\nSTORE_INTERNAL_API_SECRET=api-secret\nAPPROVAL_SIGNING_SECRET=approval-a\n",
  );
  writeFileSync(
    join(root, "apps/store/.env"),
    "GNT_STORE_INTERNAL_API_SECRET=store-secret\nGNT_APPROVAL_SIGNING_SECRET=approval-b\nZEROENTROPY_API_KEY=\n",
  );
  saveApiKey("gnt_live_test", "key-id");

  try {
    const result = await doctor({ cwd: join(root, "apps/api"), fetchImpl: healthyFetch(), nodeVersion: "22.13.0" });

    expect(result).toBe(false);
    const output = stripAnsi(logs.join("\n"));
    expect(output).toContain("Unreplaced apps/api placeholders: CONTRIBUTOR_HASH_SECRET");
    expect(output).toContain("STORE_INTERNAL_API_SECRET and GNT_STORE_INTERNAL_API_SECRET do not match");
    expect(output).toContain("APPROVAL_SIGNING_SECRET and GNT_APPROVAL_SIGNING_SECRET do not match");
    expect(output).toContain("ZEROENTROPY_API_KEY is empty");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports an unreadable env file and continues independent diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "gnt-doctor-unreadable-env-"));
  mkdirSync(join(root, "apps/api/.env"), { recursive: true });
  mkdirSync(join(root, "apps/store"), { recursive: true });
  writeFileSync(join(root, "docker-compose.yml"), "services: {}\n");
  writeFileSync(join(root, "apps/api/.env.example"), "");
  writeFileSync(
    join(root, "apps/store/.env"),
    "GNT_STORE_INTERNAL_API_SECRET=store-secret\nGNT_APPROVAL_SIGNING_SECRET=approval-secret\nZEROENTROPY_API_KEY=\n",
  );
  saveApiKey("gnt_live_test", "key-id");

  try {
    const result = await doctor({ cwd: root, fetchImpl: healthyFetch(), nodeVersion: "22.13.0" });

    expect(result).toBe(false);
    const output = stripAnsi(logs.join("\n"));
    expect(output).toContain("Could not read apps/api/.env");
    expect(output).toContain("ZEROENTROPY_API_KEY is empty");
    expect(output).toContain("API reachable at");
    expect(output).toContain("GitHub rules repository connected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a missing store approval-signing secret", async () => {
  const root = mkdtempSync(join(tmpdir(), "gnt-doctor-missing-approval-secret-"));
  mkdirSync(join(root, "apps/api"), { recursive: true });
  mkdirSync(join(root, "apps/store"), { recursive: true });
  writeFileSync(join(root, "docker-compose.yml"), "services: {}\n");
  writeFileSync(join(root, "apps/api/.env.example"), "");
  writeFileSync(
    join(root, "apps/api/.env"),
    "STORE_INTERNAL_API_SECRET=shared-secret\nAPPROVAL_SIGNING_SECRET=approval-secret\n",
  );
  writeFileSync(
    join(root, "apps/store/.env"),
    "GNT_STORE_INTERNAL_API_SECRET=shared-secret\nZEROENTROPY_API_KEY=ze-demo\n",
  );
  saveApiKey("gnt_live_test", "key-id");

  try {
    const result = await doctor({ cwd: root, fetchImpl: healthyFetch(), nodeVersion: "22.13.0" });

    expect(result).toBe(false);
    expect(stripAnsi(logs.join("\n"))).toContain("GNT_APPROVAL_SIGNING_SECRET is missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

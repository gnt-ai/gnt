// Same GNT_CONFIG_DIR-before-import pattern as test/status.test.ts -- avoids
// touching a real user's actual ~/.gnt/credentials.json.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testConfigDir = mkdtempSync(join(tmpdir(), "gnt-org-test-"));
process.env.GNT_CONFIG_DIR = testConfigDir;

// config.js reads GNT_WEB_URL into a module-level constant at import time,
// not per-call -- setting the env var here doesn't help if another test
// file already imported config.js first in this same bun test process (its
// cached WEB_URL stays whatever that import saw). mock.module overrides
// the export directly, so this is correct regardless of import order --
// but the override applies to every test file sharing this process, not
// just this one, so it has to carry every real export (API_URL/MCP_URL
// too), not just the one this file cares about, or any other file that
// imports config.js after this one loses those.
mock.module("../src/config.js", () => ({
  API_URL: "https://api.gntai.dev",
  WEB_URL: "https://gntai.test",
  MCP_URL: "https://api.gntai.dev/mcp/",
}));

const { saveApiKey } = await import("../src/credentials.js");
const { orgInvite, orgRemove, orgRename, orgShow } = await import("../src/commands/org.js");

const credentialsPath = join(testConfigDir, "credentials.json");

let originalFetch: typeof fetch;
let logs: string[];
let originalLog: typeof console.log;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  saveApiKey("gnt_live_test_key", "key-id");
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
});

async function expectExit(run: () => Promise<void>): Promise<{ exitCode: number; errors: string[] }> {
  const originalExit = process.exit;
  const exitCalls: number[] = [];
  // @ts-expect-error -- stubbing process.exit for the test
  process.exit = (code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error("process.exit called");
  };
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };

  try {
    await expect(run()).rejects.toThrow("process.exit called");
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
  return { exitCode: exitCalls[0], errors };
}

test("orgShow prints the org name, members, and pending invitations", async () => {
  globalThis.fetch = mock((url: string) => {
    expect(url).toBe("https://gntai.test/api/cli/org");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "org_1",
          name: "Acme",
          members: [{ email: "owner@acme.com", role: "owner" }],
          invitations: [{ email: "pending@acme.com", role: "member" }],
        }),
        { status: 200 },
      ),
    );
  }) as unknown as typeof fetch;

  await orgShow();

  const output = logs.join("\n");
  expect(output).toContain("Acme");
  expect(output).toContain("Members (1)");
  expect(output).toContain("owner@acme.com");
  expect(output).toContain("Pending invitations (1)");
  expect(output).toContain("pending@acme.com");
});

test("orgShow omits the invitations section when there are none pending", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ id: "org_1", name: "Acme", members: [], invitations: [] }), {
        status: 200,
      }),
    ),
  ) as unknown as typeof fetch;

  await orgShow();

  expect(logs.join("\n")).not.toContain("Pending invitations");
});

test("orgRename posts the new name and confirms", async () => {
  let sentBody: unknown;
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    expect(url).toBe("https://gntai.test/api/cli/org/rename");
    sentBody = JSON.parse(init?.body as string);
    return Promise.resolve(new Response(JSON.stringify({ name: "New Name" }), { status: 200 }));
  }) as unknown as typeof fetch;

  await orgRename("New Name");

  expect(sentBody).toEqual({ name: "New Name" });
  expect(logs.join("\n")).toContain('Renamed to "New Name"');
});

test("orgInvite defaults to member and passes through an admin role", async () => {
  let sentBody: unknown;
  globalThis.fetch = mock((_url: string, init?: RequestInit) => {
    sentBody = JSON.parse(init?.body as string);
    return Promise.resolve(new Response(JSON.stringify({ email: "a@b.com", role: "admin" }), { status: 200 }));
  }) as unknown as typeof fetch;

  await orgInvite("a@b.com", { role: "admin" });
  expect(sentBody).toEqual({ email: "a@b.com", role: "admin" });

  await orgInvite("c@d.com", {});
  expect(sentBody).toEqual({ email: "c@d.com", role: "member" });
});

test("orgRemove posts the target email", async () => {
  let sentBody: unknown;
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    expect(url).toBe("https://gntai.test/api/cli/org/remove");
    sentBody = JSON.parse(init?.body as string);
    return Promise.resolve(new Response(JSON.stringify({ email: "gone@acme.com" }), { status: 200 }));
  }) as unknown as typeof fetch;

  await orgRemove("gone@acme.com");

  expect(sentBody).toEqual({ email: "gone@acme.com" });
  expect(logs.join("\n")).toContain("Removed gone@acme.com");
});

test("surfaces the server's own error message and exits 1 on failure", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: "That person already belongs to another organization on gnt.ai." }), {
        status: 400,
      }),
    ),
  ) as unknown as typeof fetch;

  const { exitCode, errors } = await expectExit(() => orgInvite("a@b.com", {}));

  expect(exitCode).toBe(1);
  expect(errors.join("\n")).toContain("already belongs to another organization");
});

test("falls back to a status-coded message when the error body isn't JSON", async () => {
  globalThis.fetch = mock(() => Promise.resolve(new Response("", { status: 401 }))) as unknown as typeof fetch;

  const { exitCode, errors } = await expectExit(() => orgShow());

  expect(exitCode).toBe(1);
  expect(errors.join("\n")).toContain("(401)");
});

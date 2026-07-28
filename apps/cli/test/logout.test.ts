// Sets GNT_CONFIG_DIR to a scratch temp dir *before* credentials.js/
// logout.js are ever imported -- both compute their credentials path from
// it at module load time, and ESM static imports are hoisted ahead of any
// other top-level code in this file regardless of source order. Dynamic
// import() below is the only way to control that ordering, so these two
// modules never touch a real user's actual ~/.gnt/credentials.json.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testConfigDir = mkdtempSync(join(tmpdir(), "gnt-logout-test-"));
process.env.GNT_CONFIG_DIR = testConfigDir;

const { saveApiKey, tryLoadCredentials } = await import("../src/credentials.js");
const { logout } = await import("../src/commands/logout.js");

const credentialsPath = join(testConfigDir, "credentials.json");
const KEY_ID = "11111111-1111-1111-1111-111111111111";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(credentialsPath, { force: true });
});

test("clears local credentials even when the server-side revoke call fails (network down)", async () => {
  saveApiKey("gnt_live_test_key", KEY_ID);
  expect(existsSync(credentialsPath)).toBe(true);

  globalThis.fetch = mock(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;

  await logout();

  expect(existsSync(credentialsPath)).toBe(false);
  expect(tryLoadCredentials()).toBeNull();
});

test("clears local credentials even when the server responds with an error status", async () => {
  saveApiKey("gnt_live_test_key", KEY_ID);

  globalThis.fetch = mock(() => Promise.resolve(new Response(null, { status: 500 }))) as unknown as typeof fetch;

  await logout();

  expect(existsSync(credentialsPath)).toBe(false);
});

test("calls the cli-keys revoke endpoint with the stored key id and bearer token before clearing", async () => {
  saveApiKey("gnt_live_test_key", KEY_ID);

  const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await logout();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toContain(`/v1/settings/cli-keys/${KEY_ID}/revoke`);
  expect(init?.method).toBe("POST");
  expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer gnt_live_test_key");
  expect(existsSync(credentialsPath)).toBe(false);
});

test("skips the network call entirely for a session with no key id on file, and still clears local credentials", async () => {
  saveApiKey("gnt_live_test_key", null);

  const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await logout();

  expect(fetchMock).not.toHaveBeenCalled();
  expect(existsSync(credentialsPath)).toBe(false);
});

test("logging out when not logged in is a no-op, not an error", async () => {
  expect(existsSync(credentialsPath)).toBe(false);

  const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await logout();

  expect(fetchMock).not.toHaveBeenCalled();
});

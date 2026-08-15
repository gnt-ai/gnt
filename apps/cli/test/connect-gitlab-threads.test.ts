// Tests the non-TTY parts of `gnt connect gitlab-threads` / `gnt disconnect gitlab-threads`.
// The masked/plain keypress readers need a real terminal, so -- same as
// connect-datadog.test.ts -- this file covers resolve -> validate -> save and
// the disconnect path directly instead of driving keypresses.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disconnectGitlabThreads } from "../src/commands/connect-gitlab-threads.js";
import { loadMcpToken, saveMcpToken } from "../src/credentials.js";
import {
  DEFAULT_GITLAB_URL,
  GITLAB_TOKEN_ID,
  GitlabApiError,
  MissingGitlabTokenError,
  resolveGitlabCredentials,
  serializeGitlabCredentials,
  validateGitlabToken,
} from "../src/prebrain/gitlab-threads.js";

let testConfigDir: string;
let logs: string[];
let originalLog: typeof console.log;
let originalTokenEnv: string | undefined;
let originalUrlEnv: string | undefined;

beforeEach(() => {
  testConfigDir = mkdtempSync(join(tmpdir(), "gnt-connect-gitlab-threads-test-"));
  process.env.GNT_CONFIG_DIR = testConfigDir;
  originalTokenEnv = process.env.GNT_GITLAB_TOKEN;
  originalUrlEnv = process.env.GNT_GITLAB_URL;
  delete process.env.GNT_GITLAB_TOKEN;
  delete process.env.GNT_GITLAB_URL;
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
  if (originalTokenEnv === undefined) delete process.env.GNT_GITLAB_TOKEN;
  else process.env.GNT_GITLAB_TOKEN = originalTokenEnv;
  if (originalUrlEnv === undefined) delete process.env.GNT_GITLAB_URL;
  else process.env.GNT_GITLAB_URL = originalUrlEnv;
});

test("successful save with default GitLab URL after validation passes", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    expect(url).toContain("https://gitlab.com/api/v4/user");
    return new Response(JSON.stringify({ id: 1, username: "test-user" }), { status: 200 });
  }) as unknown as typeof fetch;

  const creds = resolveGitlabCredentials({ token: "glpat-test" });
  expect(creds.baseUrl).toBe(DEFAULT_GITLAB_URL);

  await validateGitlabToken(creds, fetchImpl);
  saveMcpToken(GITLAB_TOKEN_ID, serializeGitlabCredentials(creds));

  const stored = loadMcpToken(GITLAB_TOKEN_ID);
  expect(stored).toBeDefined();
  expect(JSON.parse(stored!)).toEqual({
    token: "glpat-test",
    baseUrl: "https://gitlab.com",
  });
});

test("successful save with a custom instance URL", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    expect(url).toContain("https://gitlab.example.com/api/v4/user");
    return new Response(JSON.stringify({ id: 1, username: "test-user" }), { status: 200 });
  }) as unknown as typeof fetch;

  const creds = resolveGitlabCredentials({
    token: "glpat-test",
    baseUrl: "https://gitlab.example.com/",
  });
  expect(creds.baseUrl).toBe("https://gitlab.example.com/");

  await validateGitlabToken(creds, fetchImpl);
  saveMcpToken(GITLAB_TOKEN_ID, serializeGitlabCredentials(creds));

  expect(JSON.parse(loadMcpToken(GITLAB_TOKEN_ID)!).baseUrl).toBe("https://gitlab.example.com/");
});

test("token resolves from GNT_GITLAB_TOKEN when not passed directly", () => {
  process.env.GNT_GITLAB_TOKEN = "glpat-env";
  const creds = resolveGitlabCredentials({});
  expect(creds.token).toBe("glpat-env");
  expect(creds.baseUrl).toBe(DEFAULT_GITLAB_URL);
});

test("resolve throws when no token is available anywhere", () => {
  expect(() => resolveGitlabCredentials({})).toThrow(MissingGitlabTokenError);
});

test("validation failure leaves nothing saved", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ message: "401 Unauthorized" }), { status: 401 })) as unknown as typeof fetch;

  const creds = resolveGitlabCredentials({ token: "bad-token" });

  await expect(validateGitlabToken(creds, fetchImpl)).rejects.toBeInstanceOf(GitlabApiError);
  expect(loadMcpToken(GITLAB_TOKEN_ID)).toBeUndefined();
});

test("disconnectGitlabThreads removes a saved connection and reports it removed", async () => {
  saveMcpToken(
    GITLAB_TOKEN_ID,
    serializeGitlabCredentials({
      token: "glpat-test",
      baseUrl: DEFAULT_GITLAB_URL,
    }),
  );

  await disconnectGitlabThreads();

  expect(loadMcpToken(GITLAB_TOKEN_ID)).toBeUndefined();
  expect(logs.join("\n")).toContain("Disconnected GitLab");
});

test("disconnectGitlabThreads is a no-op when nothing was connected", async () => {
  await disconnectGitlabThreads();

  expect(logs.join("\n")).toContain("No stored GitLab connection to remove.");
});

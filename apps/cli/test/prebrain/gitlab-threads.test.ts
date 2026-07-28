// Tests the direct-REST GitLab threads client against a fake fetch -- no
// real network call, no MCP client, no child process, ever runs in this
// file. Fixtures are shaped like GitLab's own published Discussions/Merge
// Requests/Issues API responses (docs.gitlab.com/api/discussions/,
// /api/merge_requests/, /api/issues/), including a full author object, a
// resolved merge-request thread, a system-generated audit-trail note, and
// a DiffNote's own `position` object, so the field-discipline tests below
// have something real to prove is stripped.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  DEFAULT_GITLAB_URL,
  GITLAB_ENDPOINTS,
  GitlabApiError,
  MissingGitlabTokenError,
  resolveGitlabCredentials,
  serializeGitlabCredentials,
  validateGitlabToken,
  walkGitlabThreads,
} from "../../src/prebrain/gitlab-threads.js";

let originalTokenEnv: string | undefined;
let originalUrlEnv: string | undefined;

beforeEach(() => {
  originalTokenEnv = process.env.GNT_GITLAB_TOKEN;
  originalUrlEnv = process.env.GNT_GITLAB_URL;
  delete process.env.GNT_GITLAB_TOKEN;
  delete process.env.GNT_GITLAB_URL;
});

afterEach(() => {
  if (originalTokenEnv === undefined) delete process.env.GNT_GITLAB_TOKEN;
  else process.env.GNT_GITLAB_TOKEN = originalTokenEnv;
  if (originalUrlEnv === undefined) delete process.env.GNT_GITLAB_URL;
  else process.env.GNT_GITLAB_URL = originalUrlEnv;
});

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

// Shaped like GitLab's own GET /projects/:id/merge_requests list entry --
// iid/title/description/web_url (the only fields this connector ever
// reads) sitting alongside labels, assignee, milestone, state, and
// approvals data (never read).
function fixtureMergeRequestListEntry(iid: number, title: string, description: string) {
  return {
    id: 900000 + iid,
    iid,
    title,
    description,
    web_url: `https://gitlab.com/acme/widgets/-/merge_requests/${iid}`,
    state: "opened",
    labels: ["backend", "needs-review"],
    assignee: { id: 42, name: "Jordan Lee", username: "jordan.lee" },
    milestone: { id: 7, title: "Q3" },
    merge_status: "can_be_merged",
  };
}

function fixtureIssueListEntry(iid: number, title: string, description: string) {
  return {
    id: 800000 + iid,
    iid,
    title,
    description,
    web_url: `https://gitlab.com/acme/widgets/-/issues/${iid}`,
    state: "opened",
    labels: ["bug"],
    assignee: { id: 99, name: "Sam Rivera", username: "sam.rivera" },
    milestone: null,
  };
}

// Shaped like GitLab's own GET /projects/:id/merge_requests/:iid/discussions
// response -- a bare array of Discussion objects, each `{ id,
// individual_note, notes: [Note, ...] }`. Includes a full author object,
// resolved/resolved_by/resolved_at (merge-request-only fields), a system
// note (dropped outright, never chunked), and a DiffNote's own `position`
// object (file paths/line numbers, never read) -- everything the
// field-discipline tests below prove never leaks into a chunk.
function fixtureMrDiscussions(bodies: string[]) {
  return [
    {
      id: "disc-1",
      individual_note: false,
      notes: [
        {
          id: 1,
          type: "DiscussionNote",
          body: bodies[0],
          author: {
            id: 42,
            name: "Jordan Lee",
            username: "jordan.lee",
            state: "active",
            avatar_url: "https://gitlab.com/avatar/jordan.png",
            web_url: "https://gitlab.com/jordan.lee",
          },
          created_at: "2026-07-01T12:00:00Z",
          updated_at: "2026-07-01T12:00:00Z",
          system: false,
          noteable_id: 5001,
          noteable_type: "MergeRequest",
          project_id: 123,
          resolvable: true,
          resolved: true,
          resolved_by: { id: 99, name: "Sam Rivera", username: "sam.rivera" },
          resolved_at: "2026-07-02T09:00:00Z",
        },
        {
          id: 2,
          type: "DiffNote",
          body: bodies[1] ?? "Looks good once the retry logic lands.",
          author: { id: 99, name: "Sam Rivera", username: "sam.rivera", state: "active" },
          created_at: "2026-07-01T13:00:00Z",
          updated_at: "2026-07-01T13:00:00Z",
          system: false,
          noteable_id: 5001,
          noteable_type: "MergeRequest",
          project_id: 123,
          resolvable: true,
          position: {
            base_sha: "abc123",
            head_sha: "def456",
            old_path: "src/checkout.ts",
            new_path: "src/checkout.ts",
            new_line: 42,
          },
        },
        {
          id: 3,
          type: null,
          body: "changed the description",
          author: { id: 42, name: "Jordan Lee", username: "jordan.lee" },
          created_at: "2026-07-01T12:30:00Z",
          system: true,
          noteable_id: 5001,
          noteable_type: "MergeRequest",
          project_id: 123,
        },
      ],
    },
  ];
}

function fixtureIssueDiscussions(bodies: string[]) {
  return [
    {
      id: "disc-2",
      individual_note: true,
      notes: [
        {
          id: 10,
          type: "DiscussionNote",
          body: bodies[0],
          author: { id: 7, name: "Alex Kim", username: "alex.kim", state: "active" },
          created_at: "2026-07-03T08:00:00Z",
          updated_at: "2026-07-03T08:00:00Z",
          system: false,
          noteable_id: 6001,
          noteable_type: "Issue",
          project_id: 123,
          resolvable: false,
        },
      ],
    },
  ];
}

function fakeFetch(
  respond: (url: string) => { body: unknown; status?: number },
  calls: RecordedCall[] = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    const { body, status } = respond(url);
    return new Response(JSON.stringify(body), { status: status ?? 200 });
  }) as unknown as typeof fetch;
}

function respondForProject(opts: {
  mrs?: unknown[];
  issues?: unknown[];
  mrDiscussions?: Record<number, unknown[]>;
  issueDiscussions?: Record<number, unknown[]>;
}): (url: string) => { body: unknown; status?: number } {
  return (url) => {
    if (/\/merge_requests\/(\d+)\/discussions/.test(url)) {
      const iid = Number(url.match(/\/merge_requests\/(\d+)\/discussions/)?.[1]);
      return { body: opts.mrDiscussions?.[iid] ?? [] };
    }
    if (/\/issues\/(\d+)\/discussions/.test(url)) {
      const iid = Number(url.match(/\/issues\/(\d+)\/discussions/)?.[1]);
      return { body: opts.issueDiscussions?.[iid] ?? [] };
    }
    if (url.includes("/merge_requests")) return { body: opts.mrs ?? [] };
    if (url.includes("/issues")) return { body: opts.issues ?? [] };
    return { body: {} };
  };
}

test("reads merge request and issue discussion threads into chunks tagged gitlab-threads, with each item's web_url as sourcePath", async () => {
  const fetchImpl = fakeFetch(
    respondForProject({
      mrs: [fixtureMergeRequestListEntry(11, "Fix checkout race", "Race condition on double-submit.")],
      issues: [fixtureIssueListEntry(21, "Login times out", "Session expires too early.")],
      mrDiscussions: { 11: fixtureMrDiscussions(["Ship the retry with exponential backoff."]) },
      issueDiscussions: { 21: fixtureIssueDiscussions(["Bumping the session TTL fixes this."]) },
    }),
  );

  const chunks = await walkGitlabThreads({ token: "glpat-secret", projects: ["acme/widgets"], fetchImpl });

  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) expect(chunk.walker).toBe("gitlab-threads");
  const sourcePaths = new Set(chunks.map((c) => c.sourcePath));
  expect(sourcePaths.has("https://gitlab.com/acme/widgets/-/merge_requests/11")).toBe(true);
  expect(sourcePaths.has("https://gitlab.com/acme/widgets/-/issues/21")).toBe(true);
  const combined = chunks.map((c) => c.text).join("\n");
  expect(combined).toContain("Fix checkout race");
  expect(combined).toContain("Ship the retry with exponential backoff");
  expect(combined).toContain("Login times out");
  expect(combined).toContain("Bumping the session TTL fixes this");
});

test("drops a system-generated note outright, and never reads author identity, timestamps, resolved state, or a DiffNote's position", async () => {
  const fetchImpl = fakeFetch(
    respondForProject({
      mrs: [fixtureMergeRequestListEntry(11, "Fix checkout race", "Race condition on double-submit.")],
      mrDiscussions: {
        11: fixtureMrDiscussions(["The root cause was a missing idempotency key."]),
      },
    }),
  );

  const chunks = await walkGitlabThreads({ token: "glpat-secret", projects: ["acme/widgets"], fetchImpl });
  const serialized = JSON.stringify(chunks);

  expect(serialized).not.toContain("changed the description"); // the system note's own body
  expect(serialized).not.toContain("Jordan Lee");
  expect(serialized).not.toContain("jordan.lee");
  expect(serialized).not.toContain("Sam Rivera");
  expect(serialized).not.toContain("sam.rivera");
  expect(serialized).not.toContain("2026-07-01T12:00:00Z");
  expect(serialized).not.toContain("2026-07-02T09:00:00Z");
  expect(serialized).not.toContain("resolvable");
  expect(serialized).not.toContain("abc123"); // position.base_sha
  expect(serialized).not.toContain("src/checkout.ts");
});

test("never reads MR/issue list metadata beyond iid/title/description/web_url -- labels, assignee, milestone, and state never leak", async () => {
  const fetchImpl = fakeFetch(
    respondForProject({
      mrs: [fixtureMergeRequestListEntry(11, "Fix checkout race", "Race condition on double-submit.")],
      mrDiscussions: { 11: fixtureMrDiscussions(["A short thread body."]) },
    }),
  );

  const chunks = await walkGitlabThreads({ token: "glpat-secret", projects: ["acme/widgets"], fetchImpl });
  const serialized = JSON.stringify(chunks);

  expect(serialized).not.toContain("needs-review");
  expect(serialized).not.toContain("can_be_merged");
  expect(serialized).not.toContain("\"opened\"");
  expect(serialized).not.toContain("\"Q3\"");
});

test("calls only the documented endpoints, sends the token as PRIVATE-TOKEN, never in the URL", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(
    respondForProject({
      mrs: [fixtureMergeRequestListEntry(11, "Fix checkout race", "desc")],
      issues: [fixtureIssueListEntry(21, "Login times out", "desc")],
      mrDiscussions: { 11: fixtureMrDiscussions(["thread body"]) },
      issueDiscussions: { 21: fixtureIssueDiscussions(["thread body"]) },
    }),
    calls,
  );

  await walkGitlabThreads({ token: "glpat-secret-token", projects: ["acme/widgets"], fetchImpl });

  expect(calls.length).toBe(4);
  for (const call of calls) {
    expect(call.url).not.toContain("glpat-secret-token");
    expect(call.headers["PRIVATE-TOKEN"]).toBe("glpat-secret-token");
  }
  expect(calls.some((c) => c.url === "https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests?order_by=updated_at&sort=desc&per_page=50")).toBe(
    true,
  );
});

test("supports a namespace/project path, URL-encoding the slash in the :id segment", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(respondForProject({}), calls);

  await walkGitlabThreads({ token: "t", projects: ["group/sub/project"], fetchImpl });

  expect(calls.every((c) => c.url.includes(encodeURIComponent("group/sub/project")))).toBe(true);
});

test("a self-managed instance URL is honored for every endpoint, not just gitlab.com", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(respondForProject({}), calls);

  await walkGitlabThreads({ token: "t", baseUrl: "https://gitlab.acme-internal.example", projects: ["1"], fetchImpl });

  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) expect(call.url.startsWith("https://gitlab.acme-internal.example/api/v4/")).toBe(true);
});

test("returns [] and never calls fetch when projects is empty, even with no token available", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const chunks = await walkGitlabThreads({ projects: [], fetchImpl });

  expect(chunks).toEqual([]);
  expect(called).toBe(false);
});

test("throws MissingGitlabTokenError when no token is available anywhere, and never attempts to fetch", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  await expect(walkGitlabThreads({ projects: ["acme/widgets"], fetchImpl })).rejects.toThrow(MissingGitlabTokenError);
  expect(called).toBe(false);
});

test("resolveGitlabCredentials: explicit values win over env vars, which win over stored credentials, applied per field", () => {
  process.env.GNT_GITLAB_TOKEN = "env-token";
  process.env.GNT_GITLAB_URL = "https://gitlab.env-example.com";
  const stored = serializeGitlabCredentials({ token: "stored-token", baseUrl: "https://gitlab.stored-example.com" });

  const resolved = resolveGitlabCredentials({ baseUrl: "https://gitlab.explicit-example.com", storedCredentials: stored });
  expect(resolved).toEqual({ token: "env-token", baseUrl: "https://gitlab.explicit-example.com" });

  delete process.env.GNT_GITLAB_TOKEN;
  delete process.env.GNT_GITLAB_URL;
  const resolvedFromStore = resolveGitlabCredentials({ storedCredentials: stored });
  expect(resolvedFromStore).toEqual({ token: "stored-token", baseUrl: "https://gitlab.stored-example.com" });

  expect(() => resolveGitlabCredentials({})).toThrow(MissingGitlabTokenError);
});

test("resolveGitlabCredentials defaults baseUrl to gitlab.com when nothing names one", () => {
  const resolved = resolveGitlabCredentials({ token: "t" });
  expect(resolved.baseUrl).toBe(DEFAULT_GITLAB_URL);
});

test("a project id/path that fails to list aborts the rest of the run with GitlabApiError, naming neither credential", async () => {
  const fetchImpl = fakeFetch(() => ({ body: { message: "404 Project Not Found" }, status: 404 }));

  try {
    await walkGitlabThreads({ token: "glpat-secret-token", projects: ["missing/project"], fetchImpl });
    throw new Error("expected walkGitlabThreads to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(GitlabApiError);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).not.toContain("glpat-secret-token");
  }
});

test("a network-level failure surfaces as GitlabApiError, not a raw rejection", async () => {
  const fetchImpl = (async () => {
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;

  await expect(walkGitlabThreads({ token: "t", projects: ["acme/widgets"], fetchImpl })).rejects.toThrow(GitlabApiError);
});

test("validateGitlabToken calls GET /user and resolves on success", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(() => ({ body: { id: 1, username: "jordan.lee" } }), calls);

  await validateGitlabToken({ token: "t", baseUrl: DEFAULT_GITLAB_URL }, fetchImpl);

  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe("https://gitlab.com/api/v4/user");
  expect(calls[0].headers["PRIVATE-TOKEN"]).toBe("t");
});

test("validateGitlabToken throws GitlabApiError on a non-200 response, without leaking the token", async () => {
  const fetchImpl = fakeFetch(() => ({ body: { message: "401 Unauthorized" }, status: 401 }));

  try {
    await validateGitlabToken({ token: "glpat-secret-token", baseUrl: DEFAULT_GITLAB_URL }, fetchImpl);
    throw new Error("expected validateGitlabToken to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(GitlabApiError);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).not.toContain("glpat-secret-token");
  }
});

test("a malformed discussions payload degrades gracefully -- non-array, missing notes, or a note missing a body all yield no crash", async () => {
  const fetchImpl = fakeFetch(
    respondForProject({
      mrs: [fixtureMergeRequestListEntry(11, "Fix checkout race", "desc")],
      mrDiscussions: { 11: [{ id: "x" }, "not-an-object", { notes: [{ system: false }, { body: "" }] }] },
    }),
  );

  const chunks = await walkGitlabThreads({ token: "t", projects: ["acme/widgets"], fetchImpl });
  expect(chunks.length).toBeGreaterThan(0); // still chunks the MR's own title/description
  const combined = chunks.map((c) => c.text).join("\n");
  expect(combined).toContain("Fix checkout race");
});

test("an entry missing iid is dropped rather than guessed at", async () => {
  const fetchImpl = fakeFetch(
    respondForProject({
      mrs: [{ title: "No iid here", description: "desc" }],
    }),
  );

  const chunks = await walkGitlabThreads({ token: "t", projects: ["acme/widgets"], fetchImpl });
  expect(chunks).toEqual([]);
});

test("the exhaustive endpoint list never calls a diff, changes, or commits endpoint path, and matches the exact five paths this file ever fetches", () => {
  // Checks the endpoint path only, not the description -- a description is
  // free to name "diff" in prose to document what's deliberately excluded
  // (see gitlab-threads.ts's own discussions-endpoint description), the
  // same way this test's own name does.
  for (const endpoint of GITLAB_ENDPOINTS) {
    expect(endpoint.path.toLowerCase()).not.toMatch(/diff|change|commit/);
  }
  expect(GITLAB_ENDPOINTS.map((e) => e.path)).toEqual([
    "GET /projects/{id}/merge_requests",
    "GET /projects/{id}/merge_requests/{merge_request_iid}/discussions",
    "GET /projects/{id}/issues",
    "GET /projects/{id}/issues/{issue_iid}/discussions",
    "GET /user",
  ]);
});

test("reads across multiple projects, one merge-request-list and one issue-list call per project", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = fakeFetch(
    (url) => {
      if (url.includes("acme%2Fwidgets")) {
        return { body: url.includes("/issues") && !url.includes("discussions") ? [] : [] };
      }
      return { body: [] };
    },
    calls,
  );

  await walkGitlabThreads({ token: "t", projects: ["acme/widgets", "42"], fetchImpl });

  expect(calls.filter((c) => c.url.includes("/merge_requests?")).length).toBe(2);
  expect(calls.filter((c) => c.url.includes("/issues?")).length).toBe(2);
});

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { MAX_REQUEST_BODY_BYTES, createFetchHandler } from "../src/http/server.ts";
import { NativeStore } from "../src/native/store.ts";
import { hashApprovalContent, signApproval } from "../src/core/approval-signing.ts";
import { fakeEmbed } from "./fake-embed.ts";
import { fakeRerank } from "./fake-rerank.ts";
import type { RulePage } from "../src/core/store.ts";

function signRule(rule: RulePage, secret: string): string {
  return signApproval(
    {
      org: rule.org,
      slug: rule.slug,
      version: rule.version,
      contentHash: hashApprovalContent({
        title: rule.title,
        body: rule.body,
        tags: rule.tags,
        status: rule.status,
      }),
    },
    secret,
  );
}

/**
 * Real HTTP requests over a real socket (Bun.serve on an ephemeral
 * port) against a real store backed by real Postgres — only the embedding
 * and rerank calls are faked, since tests must never make real paid
 * provider calls. This is the actual boundary
 * Python crosses in routers/rules.py, so it's tested as an HTTP client
 * would use it, not by calling handler functions directly.
 *
 * Needs a real DATABASE_URL, same as native-store.test.ts — see that
 * file's header comment for why this suite skips cleanly in CI without a
 * local Postgres.
 */

const DATABASE_URL =
  process.env.STORE_NATIVE_TEST_DATABASE_URL ?? "postgres://localhost:5432/gnt_store_native_test";

async function isReachable(url: string): Promise<boolean> {
  const probe = postgres(url, { connect_timeout: 2, onnotice: () => {} });
  try {
    await probe`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const reachable = await isReachable(DATABASE_URL);

// registerGithubSource's clone directory is keyed off a hash of the org id
// and lives outside any per-test tmpdir (see core/source-paths.ts's
// cloneDirFor) — it persists on disk across separate `bun test`
// invocations, same reason native-store.test.ts's own sync tests use a
// unique RUN_ID rather than a static org id: a stale clone from a PRIOR
// run would try to `git pull` from that old run's now-gone source repo.
const RUN_ID = Date.now().toString(36);

const SECRET = "test-only-internal-api-secret";
const APPROVAL_SECRET = "test-only-approval-secret-http";
let baseUrl: string;
let server: ReturnType<typeof Bun.serve>;

describe.skipIf(!reachable)("internal HTTP API", () => {
  beforeAll(async () => {
    process.env.GNT_APPROVAL_SIGNING_SECRET = APPROVAL_SECRET;
    process.env.DATABASE_URL = DATABASE_URL;
    const store = new NativeStore(fakeEmbed, fakeRerank);
    await store.init({ engine: "postgres", orgId: "org-http-bootstrap" });
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: createFetchHandler(store, SECRET),
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  function authed(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    });
  }

  function makeRule(overrides: Partial<RulePage> = {}): RulePage {
    return {
      slug: "rules/http-fixture",
      org: "org-http",
      title: "Refund window",
      body: "Customer requests a refund after 30 days: issue store credit.",
      status: "draft",
      confidence: 0.9,
      ownerId: "admin@org-http.test",
      sourceCitations: [{ source_type: "capture", source_id: "evt-http" }],
      source: null,
      tags: [],
      lastValidatedAt: null,
      version: 1,
      supersededBy: null,
      previousVersionId: null,
      approvedBy: null,
      approvedAt: null,
      createdAt: new Date().toISOString(),
      prNumber: null,
      prUrl: null,
      ...overrides,
    };
  }

  /**
   * A real local git repo standing in for a GitHub remote — cloneOrPull's
   * auth header is http-transport-specific and simply doesn't apply to a
   * local-path clone, so this exercises the real git mechanics (clone,
   * register as a source, sync/import) without needing real network access
   * or a real GitHub PAT.
   */
  function createLocalTestRepo(
    files: Record<string, string> = { "rules/seed.md": "---\ntitle: seed\nstatus: approved\nversion: 1\n---\n\nSeed content.\n" },
  ): string {
    const dir = mkdtempSync(join(tmpdir(), "gnt-store-test-repo-"));
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = join(dir, relativePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content);
    }
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync(
      "git",
      ["-C", dir, "-c", "user.email=test@test.com", "-c", "user.name=test", "commit", "-q", "-m", "seed"],
    );
    return dir;
  }

  test("GET /health requires no auth", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("every other route rejects a missing/wrong bearer token", async () => {
    const noAuth = await fetch(`${baseUrl}/rules?org=org-http`);
    expect(noAuth.status).toBe(401);

    const wrongAuth = await fetch(`${baseUrl}/rules?org=org-http`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(wrongAuth.status).toBe(401);
  });

  test("the correct bearer token is accepted", async () => {
    const res = await fetch(`${baseUrl}/rules?org=org-http`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
  });

  test("a wrong bearer token of the SAME length as the real secret is rejected, not thrown", async () => {
    // Regression check for the timing-safe compare: timingSafeEqual throws
    // on a buffer-length mismatch, so a same-length wrong token exercises
    // the actual constant-time byte comparison rather than the length
    // short-circuit the "wrong-token" case above hits.
    const sameLengthWrongToken = "x".repeat(SECRET.length);
    expect(sameLengthWrongToken.length).toBe(SECRET.length);
    expect(sameLengthWrongToken).not.toBe(SECRET);

    const res = await fetch(`${baseUrl}/rules?org=org-http`, {
      headers: { Authorization: `Bearer ${sameLengthWrongToken}` },
    });
    expect(res.status).toBe(401);
  });

  test("a wrong bearer token shorter than the real secret is rejected without throwing", async () => {
    const res = await fetch(`${baseUrl}/rules?org=org-http`, {
      headers: { Authorization: "Bearer x" },
    });
    expect(res.status).toBe(401);
  });

  test("a wrong bearer token longer than the real secret is rejected without throwing", async () => {
    const res = await fetch(`${baseUrl}/rules?org=org-http`, {
      headers: { Authorization: `Bearer ${SECRET}-and-then-some-more` },
    });
    expect(res.status).toBe(401);
  });

  test("every non-health route requires the bearer token, not just /rules", async () => {
    // Mirrors every branch of createFetchHandler's router exactly (minus
    // /health, which is deliberately unauthenticated). The auth check runs
    // once, before routing, so these don't need well-formed bodies/params —
    // if any of them ever bypassed that single choke point, this route
    // would 400/404 instead of 401 and the test would catch it.
    const routes: { method: string; path: string }[] = [
      { method: "POST", path: "/rules" },
      { method: "GET", path: "/rules?org=org-http" },
      { method: "GET", path: "/rules/rules%2Fhttp-fixture?org=org-http" },
      { method: "GET", path: "/rules/by-pr/1?org=org-http" },
      { method: "POST", path: "/search" },
      { method: "POST", path: "/audit" },
      { method: "GET", path: "/audit/rules%2Fhttp-fixture?org=org-http" },
      { method: "POST", path: "/ingest" },
      { method: "POST", path: "/sources" },
      { method: "POST", path: "/sync" },
    ];

    for (const { method, path } of routes) {
      const res = await fetch(`${baseUrl}${path}`, { method });
      expect(res.status).toBe(401);
    }
  });

  test("a request body larger than MAX_REQUEST_BODY_BYTES is rejected with 413, not silently truncated or allowed through", async () => {
    const oversizedBody = "x".repeat(MAX_REQUEST_BODY_BYTES + 1);
    const res = await authed("/rules", {
      method: "POST",
      body: JSON.stringify({ rule: makeRule({ slug: "rules/http-oversized", body: oversizedBody }) }),
    });
    expect(res.status).toBe(413);
  });

  test("POST /rules -> GET /rules/:slug round trip", async () => {
    const rule = makeRule();
    const putRes = await authed("/rules", { method: "POST", body: JSON.stringify({ rule }) });
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({ slug: rule.slug });

    const getRes = await authed(`/rules/${encodeURIComponent(rule.slug)}?org=org-http`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as RulePage;
    expect(fetched.title).toBe(rule.title);
    expect(fetched.status).toBe("draft");
  });

  test("GET /rules/:slug for a missing org returns 404, not another org's data", async () => {
    const rule = makeRule({ slug: "rules/http-other-org", org: "org-http-2" });
    await authed("/rules", { method: "POST", body: JSON.stringify({ rule }) });

    const res = await authed(`/rules/${encodeURIComponent(rule.slug)}?org=org-http`);
    expect(res.status).toBe(404);
  });

  test("PUT with status approved and no signature is rejected with 403, not 500", async () => {
    const rule = makeRule({ slug: "rules/http-unsigned-approve", status: "approved" });
    const res = await authed("/rules", { method: "POST", body: JSON.stringify({ rule }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/approvalSignature/);
  });

  test("PUT with status approved and a valid signature succeeds over HTTP", async () => {
    // Distinct title/body from makeRule()'s default -- otherwise this rule
    // is byte-identical to rules/http-fixture (draft, created above) and
    // hybrid search's cross-page text-similarity dedup collapses the two,
    // which can keep the draft and drop this approved one depending on
    // insertion order. Real orgs hit this too (a draft revision with
    // near-identical wording to the rule it's revising); this fixture
    // just needs its own distinct wording to test search() in isolation
    // from that dedup behavior.
    const rule = makeRule({
      slug: "rules/http-signed-approve",
      title: "Refund store credit policy",
      body: "When a customer requests a refund after 30 days, the support team issues store credit instead of a cash refund.",
      status: "approved",
      approvedAt: new Date().toISOString(),
    });
    const approvalSignature = signRule(rule, APPROVAL_SECRET);
    const res = await authed("/rules", {
      method: "POST",
      body: JSON.stringify({ rule, approvalSignature }),
    });
    expect(res.status).toBe(200);

    const fetched = await authed(`/rules/${encodeURIComponent(rule.slug)}?org=org-http`);
    expect((await fetched.json()).status).toBe("approved");
  });

  test("GET /rules lists by status", async () => {
    const res = await authed("/rules?org=org-http&status=approved");
    expect(res.status).toBe(200);
    const rules = (await res.json()) as RulePage[];
    expect(rules.some((r) => r.slug === "rules/http-signed-approve")).toBe(true);
    expect(rules.every((r) => r.status === "approved")).toBe(true);
  });

  test("POST /search finds an approved rule and respects org scoping", async () => {
    const res = await authed("/search", {
      method: "POST",
      body: JSON.stringify({ query: "refund store credit", orgId: "org-http", status: "approved" }),
    });
    expect(res.status).toBe(200);
    const hits = await res.json();
    expect(hits.some((h: RulePage) => h.slug === "rules/http-signed-approve")).toBe(true);
  });

  test("POST /audit appends an entry without throwing", async () => {
    const res = await authed("/audit", {
      method: "POST",
      body: JSON.stringify({
        org: "org-http",
        ruleSlug: "rules/http-signed-approve",
        actorId: "admin@org-http.test",
        action: "approved",
        before: { status: "in_review" },
        after: { status: "approved" },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("GET /audit/:slug returns the entry just appended", async () => {
    const res = await authed(
      `/audit/${encodeURIComponent("rules/http-signed-approve")}?org=org-http`,
    );
    expect(res.status).toBe(200);
    const trail = await res.json();
    expect(trail.some((e: { action: string }) => e.action === "approved")).toBe(true);
  });

  test("genuinely malformed JSON gets 400, not a raw 500 stack trace", async () => {
    const res = await authed("/rules", { method: "POST", body: "{" });
    expect(res.status).toBe(400);
  });

  test("well-formed JSON missing required rule fields gets 400", async () => {
    const res = await authed("/rules", { method: "POST", body: JSON.stringify({ rule: { slug: "x" } }) });
    expect(res.status).toBe(400);
  });

  test("GET /rules/by-pr/:pr_number returns a one-element array for a single matching rule", async () => {
    const rule = makeRule({
      slug: "rules/http-by-pr",
      status: "pending_merge",
      prNumber: 123,
      prUrl: "https://github.com/acme/rules/pull/123",
    });
    await authed("/rules", { method: "POST", body: JSON.stringify({ rule }) });

    const res = await authed("/rules/by-pr/123?org=org-http");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RulePage[];
    expect(body.map((r) => r.slug)).toEqual([rule.slug]);
  });

  // Batched propose puts several rules on the same PR (same prNumber),
  // so the webhook handler needs every one of them back, not just the
  // first the store happens to iterate to.
  test("GET /rules/by-pr/:pr_number returns every rule sharing that PR number", async () => {
    const ruleOne = makeRule({
      slug: "rules/http-by-pr-batch-1",
      status: "pending_merge",
      prNumber: 456,
      prUrl: "https://github.com/acme/rules/pull/456",
    });
    const ruleTwo = makeRule({
      slug: "rules/http-by-pr-batch-2",
      title: "A second, distinct rule",
      body: "Distinct wording so hybrid search's dedup doesn't collapse this with ruleOne.",
      status: "pending_merge",
      prNumber: 456,
      prUrl: "https://github.com/acme/rules/pull/456",
    });
    await authed("/rules", { method: "POST", body: JSON.stringify({ rule: ruleOne }) });
    await authed("/rules", { method: "POST", body: JSON.stringify({ rule: ruleTwo }) });

    const res = await authed("/rules/by-pr/456?org=org-http");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RulePage[];
    expect(body.map((r) => r.slug).sort()).toEqual([ruleOne.slug, ruleTwo.slug].sort());
  });

  test("GET /rules/by-pr/:pr_number never leaks another org's rules sharing the same PR number", async () => {
    // PR numbers are per-repo on GitHub, so two different orgs' repos both
    // having an open PR #789 is an expected collision, not a contrived one
    // — this is the store-level half of the same isolation guarantee
    // test_github_webhook.py's cross-org PR-number-collision test proves
    // end to end.
    const orgHttpRule = makeRule({
      slug: "rules/http-by-pr-org-scope-a",
      status: "pending_merge",
      prNumber: 789,
      prUrl: "https://github.com/acme/rules/pull/789",
    });
    const otherOrgRule = makeRule({
      slug: "rules/http-by-pr-org-scope-b",
      org: "org-http-other",
      title: "Another org's rule on the same PR number",
      body: "Belongs to a completely different org — must never show up in org-http's results.",
      status: "pending_merge",
      prNumber: 789,
      prUrl: "https://github.com/other/rules/pull/789",
    });
    await authed("/rules", { method: "POST", body: JSON.stringify({ rule: orgHttpRule }) });
    await authed("/rules", { method: "POST", body: JSON.stringify({ rule: otherOrgRule }) });

    const res = await authed("/rules/by-pr/789?org=org-http");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RulePage[];
    expect(body.map((r) => r.slug)).toEqual([orgHttpRule.slug]);
  });

  test("GET /rules/by-pr/:pr_number returns an empty array (still 200) for an unknown PR number", async () => {
    const res = await authed("/rules/by-pr/999999?org=org-http");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("GET /rules/by-pr/:pr_number rejects a non-numeric PR", async () => {
    const res = await authed("/rules/by-pr/not-a-number?org=org-http");
    expect(res.status).toBe(400);
  });

  test("POST /sources clones a real repo and registers it as a source", async () => {
    const repoPath = createLocalTestRepo();
    const res = await authed("/sources", {
      method: "POST",
      body: JSON.stringify({ org: `org-http-sources-${RUN_ID}`, repoUrl: repoPath, pat: "unused-for-a-local-repo" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("POST /sync imports the cloned repo's real content", async () => {
    const repoPath = createLocalTestRepo();
    const org = `org-http-sync-${RUN_ID}`;
    await authed("/sources", {
      method: "POST",
      body: JSON.stringify({ org, repoUrl: repoPath, pat: "unused-for-a-local-repo" }),
    });

    const res = await authed("/sync", {
      method: "POST",
      body: JSON.stringify({ org, repoUrl: repoPath, pat: "unused-for-a-local-repo" }),
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.added).toBeGreaterThan(0);
  });

  test("POST /sources on a bad repo path fails with a clean 502, not a raw 500", async () => {
    const res = await authed("/sources", {
      method: "POST",
      body: JSON.stringify({ org: "org-http-bad-source", repoUrl: "/nonexistent/path/nope", pat: "x" }),
    });
    expect(res.status).toBe(502);
  });

  test("a synced rule's title/body/tags read back correctly, not empty", async () => {
    const org = `org-http-reconcile-${RUN_ID}`;
    const repoPath = createLocalTestRepo({
      "rules/reconcile-test.md":
        "---\ntitle: Refund window\nstatus: approved\nconfidence: 0.82\nowner_id: admin\n" +
        "source_citations: []\ntags:\n  - billing\n  - refunds\nlast_validated_at: null\nversion: 1\n" +
        "superseded_by: null\nprevious_version_id: null\napproved_by: admin\n" +
        "approved_at: '2026-07-14T00:00:00Z'\ncreated_at: '2026-07-14T00:00:00Z'\n" +
        "pr_number: null\npr_url: null\n---\n\nRefunds are honored within 30 days of purchase.\n",
    });

    await authed("/sources", {
      method: "POST",
      body: JSON.stringify({ org, repoUrl: repoPath, pat: "unused-for-a-local-repo" }),
    });
    await authed("/sync", {
      method: "POST",
      body: JSON.stringify({ org, repoUrl: repoPath, pat: "unused-for-a-local-repo" }),
    });

    const res = await authed(`/rules/${encodeURIComponent("rules/reconcile-test")}?org=${org}`);
    expect(res.status).toBe(200);
    const rule = (await res.json()) as RulePage;
    expect(rule.title).toBe("Refund window");
    expect(rule.body).toBe("Refunds are honored within 30 days of purchase.");
    expect(rule.tags.sort()).toEqual(["billing", "refunds"]);
  });

  // Org offboarding's store-side delete.
  test("POST /sources/delete removes an org's rules mirror — the deleted rule is gone afterward", async () => {
    const rule = makeRule({ slug: "rules/http-delete-me", org: "org-http-delete" });
    const putRes = await authed("/rules", { method: "POST", body: JSON.stringify({ rule }) });
    expect(putRes.status).toBe(200);

    const deleteRes = await authed("/sources/delete", {
      method: "POST",
      body: JSON.stringify({ org: "org-http-delete" }),
    });
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ pagesDeleted: 1 });

    const getRes = await authed(`/rules/${encodeURIComponent(rule.slug)}?org=org-http-delete`);
    expect(getRes.status).toBe(404);
  });

  test("POST /sources/delete for an org that never wrote a rule is a no-op, not an error", async () => {
    const res = await authed("/sources/delete", {
      method: "POST",
      body: JSON.stringify({ org: "org-http-delete-never-wrote-anything" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pagesDeleted: 0 });
  });

  test("POST /sources/delete without an org field gets 400, not a raw 500", async () => {
    const res = await authed("/sources/delete", { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });
});

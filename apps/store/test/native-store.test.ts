import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import { NativeStore } from "../src/native/store.ts";
import type { RerankFn } from "../src/native/rerank.ts";
import type { RulePage } from "../src/core/store.ts";
import { hashApprovalContent, signApproval } from "../src/core/approval-signing.ts";
import { fakeEmbed } from "./fake-embed.ts";
import { fakeRerank } from "./fake-rerank.ts";

/**
 * NativeStore's own contract coverage — put/get/search round trip, the
 * approval gate, cross-org isolation, org-id normalization, offboarding,
 * hybrid-search ranking, and git-native sync, all against a real
 * Postgres/pgvector database.
 *
 * Unlike every other test file here, this one needs a real DATABASE_URL —
 * there is no in-memory native mode (NativeStore is Postgres-only by
 * design). CI's store job runs a Postgres service for exactly this; it
 * also runs for real wherever a local Postgres is reachable
 * (`createdb gnt_store_native_test` with the `vector` extension available).
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

function makeRule(overrides: Partial<RulePage> = {}): RulePage {
  return {
    slug: "rules/refund-window",
    org: "org-a",
    title: "Refund window",
    body: "Customer requests a refund after 30 days: issue store credit instead of a cash refund.",
    status: "approved",
    confidence: 0.92,
    ownerId: "admin@org-a.test",
    sourceCitations: [{ source_type: "capture", source_id: "evt-1" }],
    source: null,
    tags: ["refunds"],
    lastValidatedAt: new Date().toISOString(),
    version: 1,
    supersededBy: null,
    previousVersionId: null,
    approvedBy: "admin@org-a.test",
    approvedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    prNumber: null,
    prUrl: null,
    ...overrides,
  };
}

function signedPut(store: NativeStore, rule: RulePage, secret: string) {
  const approvalSignature =
    rule.status === "approved"
      ? signApproval(
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
        )
      : undefined;
  return store.putPage(rule, { approvalSignature });
}

async function freshStore(orgId: string, rerankFn: RerankFn = fakeRerank): Promise<NativeStore> {
  process.env.DATABASE_URL = DATABASE_URL;
  const store = new NativeStore(fakeEmbed, rerankFn);
  await store.init({ engine: "postgres", orgId });
  return store;
}

const DIM = 1280;
/** A single-value-filled vector — every dimension identical, so cosine
 * similarity against another same-fill vector is exactly 1.0 and against
 * an opposite-signed one is exactly -1.0. Used to hand-craft embeddings
 * for the hybrid-search tests below without depending on fakeEmbed's
 * non-semantic (no similarity signal) output. */
function fillVector(value: number): Float32Array {
  return new Float32Array(DIM).fill(value);
}

describe.skipIf(!reachable)("NativeStore (real Postgres/pgvector)", () => {
  const SECRET = "test-only-native-store-signing-secret";

  test("init() twice does not throw — bootstrap is idempotent", async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    const store = new NativeStore(fakeEmbed);
    await store.init({ engine: "postgres", orgId: "org-native-idempotent" });
    await expect(store.init({ engine: "postgres", orgId: "org-native-idempotent" })).resolves.toBeUndefined();
  });

  test("put -> get -> search round trip", async () => {
    process.env.GNT_APPROVAL_SIGNING_SECRET = SECRET;
    const store = await freshStore("org-native-a");
    const rule = makeRule({ slug: "rules/native-refund-window", org: "org-native-a" });
    const { slug } = await signedPut(store, rule, SECRET);
    expect(slug).toBe(rule.slug);

    const fetched = await store.getPage(slug, { orgId: "org-native-a" });
    expect(fetched?.body).toBe(rule.body);
    expect(fetched?.status).toBe("approved");
    expect(fetched?.tags).toEqual(["refunds"]);

    const listed = await store.listPages({ status: "approved", orgId: "org-native-a" });
    expect(listed.map((r) => r.slug)).toContain(slug);

    const hits = await store.search("refund after 30 days", { orgId: "org-native-a", status: "approved" });
    expect(hits.some((h) => h.slug === slug)).toBe(true);
  });

  test("appendAudit does not throw and health reports the page", async () => {
    const store = await freshStore("org-native-audit");
    const rule = makeRule({ slug: "rules/native-shipping-window", org: "org-native-audit" });
    await signedPut(store, rule, SECRET);

    await store.appendAudit({
      org: "org-native-audit",
      ruleSlug: rule.slug,
      actorId: "admin@org-native-audit.test",
      action: "approved",
      before: { ...rule, status: "in_review" },
      after: { ...rule },
    });

    const health = await store.health();
    expect(health.ok).toBe(true);
    expect(health.engine).toBe("postgres");
    expect(health.pageCount).toBeGreaterThanOrEqual(1);
  });

  test("getAuditTrail returns entries oldest-first with full before/after snapshots", async () => {
    const store = await freshStore("org-native-audit-trail");
    const rule = makeRule({
      slug: "rules/native-audit-trail-fixture",
      org: "org-native-audit-trail",
      status: "draft",
      approvedBy: null,
      approvedAt: null,
    });
    await store.putPage(rule);

    await store.appendAudit({
      org: "org-native-audit-trail",
      ruleSlug: rule.slug,
      actorId: "admin@org-native-audit-trail.test",
      action: "created",
      before: null,
      after: { ...rule },
    });
    await store.appendAudit({
      org: "org-native-audit-trail",
      ruleSlug: rule.slug,
      actorId: "admin@org-native-audit-trail.test",
      action: "submitted",
      before: { ...rule, status: "draft" },
      after: { ...rule, status: "in_review" },
    });

    const trail = await store.getAuditTrail(rule.slug, { orgId: "org-native-audit-trail" });
    expect(trail.map((e) => e.action)).toEqual(["created", "submitted"]);
    expect(trail[0].before).toBeNull();
    expect(trail[1].after.status).toBe("in_review");
  });

  test("approval gate: approved status with no signature is rejected", async () => {
    process.env.GNT_APPROVAL_SIGNING_SECRET = SECRET;
    const store = await freshStore("org-native-gate");
    const rule = makeRule({ slug: "rules/native-gate-fixture", org: "org-native-gate" });
    await expect(store.putPage(rule)).rejects.toThrow(/approvalSignature/);
  });

  test("approval gate: draft writes without any signature", async () => {
    const store = await freshStore("org-native-gate-draft");
    const rule = makeRule({
      slug: "rules/native-gate-draft",
      org: "org-native-gate-draft",
      status: "draft",
      approvedBy: null,
      approvedAt: null,
    });
    await expect(store.putPage(rule)).resolves.toEqual({ slug: rule.slug });
  });

  test("cross-org isolation: org B cannot get, list, or search org A's rule", async () => {
    process.env.GNT_APPROVAL_SIGNING_SECRET = SECRET;
    const store = await freshStore("org-native-alpha");
    const ruleA = makeRule({ slug: "rules/native-alpha-secret", org: "org-native-alpha" });
    await signedPut(store, ruleA, SECRET);
    await signedPut(
      store,
      makeRule({ slug: "rules/native-beta-own-rule", org: "org-native-beta" }),
      SECRET,
    );

    const leaked = await store.getPage(ruleA.slug, { orgId: "org-native-beta" });
    expect(leaked).toBeNull();

    const listed = await store.listPages({ status: "approved", orgId: "org-native-beta" });
    expect(listed.map((r) => r.slug)).not.toContain(ruleA.slug);

    const hits = await store.search(ruleA.body, { orgId: "org-native-beta", status: "approved" });
    expect(hits.some((h) => h.slug === ruleA.slug)).toBe(false);

    const ownHits = await store.search(ruleA.body, { orgId: "org-native-alpha", status: "approved" });
    expect(ownHits.some((h) => h.slug === ruleA.slug)).toBe(true);
  });

  test("real-shaped org id (Better Auth mixed-case, no underscore) normalizes and round-trips", async () => {
    process.env.GNT_APPROVAL_SIGNING_SECRET = SECRET;
    const orgId = "jugIVINskvJJYS0h17KkZNSPJYUSLoNa"; // 32 chars, mixed case
    const store = await freshStore(orgId);
    const rule = makeRule({ slug: "rules/native-real-shaped-org", org: orgId });
    await signedPut(store, rule, SECRET);

    const fetched = await store.getPage(rule.slug, { orgId });
    expect(fetched?.org).toBe(orgId);
    expect(fetched?.status).toBe("approved");
  });

  test("deleteOrgSource cascades pages/chunks/timeline and is a no-op for an org with none", async () => {
    process.env.GNT_APPROVAL_SIGNING_SECRET = SECRET;
    const store = await freshStore("org-native-delete");
    const rule = makeRule({ slug: "rules/native-delete-me", org: "org-native-delete" });
    await signedPut(store, rule, SECRET);

    const result = await store.deleteOrgSource("org-native-delete");
    expect(result.pagesDeleted).toBe(1);
    expect(await store.getPage(rule.slug, { orgId: "org-native-delete" })).toBeNull();

    const noop = await store.deleteOrgSource("org-native-never-wrote-anything");
    expect(noop).toEqual({ pagesDeleted: 0 });
  });

  test("keyword arm surfaces a hit the vector arm alone can't distinguish", async () => {
    process.env.GNT_APPROVAL_SIGNING_SECRET = SECRET;
    const orgId = "org-native-hybrid-keyword";
    // Every text embeds to the identical vector, so the vector arm ties
    // every candidate at cosine similarity 1.0 — any ranking has to come
    // from the keyword arm's real Postgres full-text match.
    const flatEmbed = async () => fillVector(1);
    process.env.DATABASE_URL = DATABASE_URL;
    const flatStore = new NativeStore(flatEmbed, fakeRerank);
    await flatStore.init({ engine: "postgres", orgId });

    const distractor = makeRule({
      slug: "rules/native-kw-distractor",
      org: orgId,
      title: "Vacation accrual",
      body: "Employees accrue paid time off monthly per the handbook.",
    });
    const target = makeRule({
      slug: "rules/native-kw-target",
      org: orgId,
      title: "Expense report deadline",
      body: "Submit expense reports containing token zylophonemarker within 14 days of the purchase date.",
    });
    await signedPut(flatStore, distractor, SECRET);
    await signedPut(flatStore, target, SECRET);

    const hits = await flatStore.search("zylophonemarker", { orgId, status: "approved" });
    expect(hits.some((h) => h.slug === target.slug)).toBe(true);
  });

  test("title-phrase boost outranks a stronger keyword-only competitor", async () => {
    process.env.GNT_APPROVAL_SIGNING_SECRET = SECRET;
    const orgId = "org-native-hybrid-title-boost";
    process.env.DATABASE_URL = DATABASE_URL;
    // Every text embeds to the identical vector — the vector arm ties
    // both rules, so the pre-boost ranking is entirely up to the keyword
    // arm, and the title boost is the only thing that can flip it.
    const flatEmbed = async () => fillVector(1);
    const store = new NativeStore(flatEmbed, fakeRerank);
    await store.init({ engine: "postgres", orgId });

    const query = "widget refund escalation";
    // Title-exact match for the query — the only rule the boost fires on.
    const titleMatch = makeRule({
      slug: "rules/native-title-boost-match",
      org: orgId,
      title: "Widget refund escalation",
      body: "See the support handbook for general details.",
    });
    // No title overlap with the query at all, but the query phrase repeats
    // three times in the body — a genuinely stronger keyword-arm signal
    // than titleMatch's single (title-only) occurrence.
    const keywordWinner = makeRule({
      slug: "rules/native-title-boost-competitor",
      org: orgId,
      title: "Escalation handling overview",
      body:
        "Widget refund escalation needed. Widget refund escalation reviewed by a lead. " +
        "Widget refund escalation closed once resolved.",
    });
    await signedPut(store, keywordWinner, SECRET);
    await signedPut(store, titleMatch, SECRET);

    const hits = await store.search(query, { orgId, status: "approved" });
    expect(hits[0]?.slug).toBe(titleMatch.slug);
  });

  test("hybrid search isolation: org A's query never surfaces org B's rule through either arm", async () => {
    process.env.GNT_APPROVAL_SIGNING_SECRET = SECRET;
    const orgA = "org-native-hybrid-iso-a";
    const orgB = "org-native-hybrid-iso-b";
    process.env.DATABASE_URL = DATABASE_URL;
    // Identical embeddings for every text means a leaked vector-arm row
    // would rank just as high as a legitimate one — isolation has to come
    // from the source_id scoping in the SQL itself, not from a low score.
    const flatEmbed = async () => fillVector(1);
    const storeA = new NativeStore(flatEmbed, fakeRerank);
    await storeA.init({ engine: "postgres", orgId: orgA });
    const storeB = new NativeStore(flatEmbed, fakeRerank);
    await storeB.init({ engine: "postgres", orgId: orgB });

    const secretTerm = "quixomatic-provisioning-token";
    const ruleB = makeRule({
      slug: "rules/native-iso-b-secret",
      org: orgB,
      title: "Provisioning tokens",
      body: `Rotate the quixomatic-provisioning-token value every quarter.`,
    });
    await signedPut(storeB, ruleB, SECRET);

    const hitsFromA = await storeA.search(secretTerm, { orgId: orgA, status: "approved" });
    expect(hitsFromA.some((h) => h.slug === ruleB.slug)).toBe(false);

    const hitsFromB = await storeB.search(secretTerm, { orgId: orgB, status: "approved" });
    expect(hitsFromB.some((h) => h.slug === ruleB.slug)).toBe(true);
  });
});

/**
 * native/sync.ts coverage — a real local git repo standing in for a GitHub
 * remote, same fixture technique as http-server.test.ts's
 * createLocalTestRepo (a local-path clone exercises the real git mechanics
 * without needing network access or a real PAT). Unlike that file's own
 * (currently-skipped) sync tests, NativeStore's registerGithubSource/
 * syncGithubSource never call into the vendored engine's clone path at all
 * — both go through this repo's own cloneOrPull (adapters/engine/
 * github-clone.ts) — so this suite is the "nice proof" the task asked for:
 * the same kind of register+sync+read-back round trip, working cleanly on
 * the native path.
 */
describe.skipIf(!reachable)("NativeStore.syncGithubSource (real Postgres + a real local git repo)", () => {
  // Unique per test-file execution -- sourceId is a deterministic hash of
  // orgId (see source-paths.ts), and both the clone dir and sources.last_commit
  // persist in the real Postgres DB across separate `bun test` invocations, so
  // a static orgId would make "first sync" assertions flaky on a second run
  // against the same local database.
  const RUN_ID = Date.now().toString(36);

  function initTestRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "gnt-native-sync-test-repo-"));
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@test.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "test"]);
    return dir;
  }

  function writeRuleFile(dir: string, relPath: string, frontmatter: Record<string, unknown>, body: string): void {
    const fullPath = join(dir, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    const yaml = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");
    writeFileSync(fullPath, `---\n${yaml}\n---\n\n${body}\n`);
  }

  function commitAll(dir: string, message: string): void {
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", message]);
  }

  function freshNativeStore(embed = fakeEmbed): NativeStore {
    process.env.DATABASE_URL = DATABASE_URL;
    return new NativeStore(embed, fakeRerank);
  }

  function approvedFrontmatter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      title: "Refund window",
      status: "approved",
      confidence: 0.82,
      owner_id: "admin",
      source_citations: [],
      tags: ["billing", "refunds"],
      last_validated_at: null,
      version: 1,
      superseded_by: null,
      previous_version_id: null,
      approved_by: "admin",
      approved_at: "2026-07-14T00:00:00Z",
      created_at: "2026-07-14T00:00:00Z",
      pr_number: null,
      pr_url: null,
      ...overrides,
    };
  }

  test("first sync imports every rules/*.md file and reads back title/body/tags correctly", async () => {
    const repo = initTestRepo();
    writeRuleFile(
      repo,
      "rules/sync-reconcile.md",
      approvedFrontmatter(),
      "Refunds are honored within 30 days of purchase.",
    );
    commitAll(repo, "seed");

    const store = freshNativeStore();
    await store.init({ engine: "postgres", orgId: `org-native-sync-first-${RUN_ID}` });
    const result = await store.syncGithubSource(`org-native-sync-first-${RUN_ID}`, repo, "unused-for-a-local-repo");
    expect(result.status).toBe("first_sync");
    expect(result.added).toBe(1);
    expect(result.embedded).toBe(1);
    expect(result.pagesAffected).toEqual(["rules/sync-reconcile"]);

    // Reproduces the real bug pageToRule/#rowToRule's frontmatter-first
    // read exists to fix: a page written the engine's generic-importer way
    // (title/tags promoted OUT of frontmatter) used to read back empty.
    // This store's own sync writes putPage's frontmatter shape instead
    // (see sync.ts's header comment), so this is also a round-trip check
    // on that shape.
    const rule = await store.getPage("rules/sync-reconcile", { orgId: `org-native-sync-first-${RUN_ID}` });
    expect(rule?.title).toBe("Refund window");
    expect(rule?.body).toBe("Refunds are honored within 30 days of purchase.");
    expect(rule?.tags.sort()).toEqual(["billing", "refunds"]);
    expect(rule?.status).toBe("approved");
  });

  test("re-sync with no repo changes is idempotent: no duplicate rows, no re-embed", async () => {
    const repo = initTestRepo();
    writeRuleFile(repo, "rules/idempotent.md", approvedFrontmatter({ title: "Idempotent rule" }), "Body v1.");
    commitAll(repo, "seed");

    let embedCalls = 0;
    const countingEmbed = async (text: string) => {
      embedCalls++;
      return fakeEmbed(text);
    };

    const store = freshNativeStore(countingEmbed);
    await store.init({ engine: "postgres", orgId: `org-native-sync-idempotent-${RUN_ID}` });
    const first = await store.syncGithubSource(`org-native-sync-idempotent-${RUN_ID}`, repo, "x");
    expect(first.added).toBe(1);
    const callsAfterFirst = embedCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await store.syncGithubSource(`org-native-sync-idempotent-${RUN_ID}`, repo, "x");
    expect(second.status).toBe("up_to_date");
    expect(second.added).toBe(0);
    expect(second.modified).toBe(0);
    expect(second.deleted).toBe(0);
    expect(second.embedded).toBe(0);
    expect(embedCalls).toBe(callsAfterFirst); // no re-embed on an unchanged repo

    const listed = await store.listPages({ status: "approved", orgId: `org-native-sync-idempotent-${RUN_ID}` });
    expect(listed.filter((r) => r.slug === "rules/idempotent")).toHaveLength(1); // no duplicate row
  });

  test("a repo-side edit updates the existing page without a new row, and re-embeds only the changed one", async () => {
    const repo = initTestRepo();
    writeRuleFile(repo, "rules/edit-me.md", approvedFrontmatter({ title: "Edit target" }), "Original body.");
    writeRuleFile(repo, "rules/untouched.md", approvedFrontmatter({ title: "Untouched" }), "Stays the same.");
    commitAll(repo, "seed");

    let embedCalls = 0;
    const countingEmbed = async (text: string) => {
      embedCalls++;
      return fakeEmbed(text);
    };
    const store = freshNativeStore(countingEmbed);
    await store.init({ engine: "postgres", orgId: `org-native-sync-edit-${RUN_ID}` });
    await store.syncGithubSource(`org-native-sync-edit-${RUN_ID}`, repo, "x");
    const callsAfterSeed = embedCalls;

    writeRuleFile(repo, "rules/edit-me.md", approvedFrontmatter({ title: "Edit target" }), "Updated body.");
    commitAll(repo, "edit");

    const result = await store.syncGithubSource(`org-native-sync-edit-${RUN_ID}`, repo, "x");
    expect(result.status).toBe("synced");
    expect(result.modified).toBe(1);
    expect(result.added).toBe(0);
    expect(result.embedded).toBe(1); // only the changed file re-embeds
    expect(embedCalls).toBe(callsAfterSeed + 1);

    const edited = await store.getPage("rules/edit-me", { orgId: `org-native-sync-edit-${RUN_ID}` });
    expect(edited?.body).toBe("Updated body.");
    const untouched = await store.getPage("rules/untouched", { orgId: `org-native-sync-edit-${RUN_ID}` });
    expect(untouched?.body).toBe("Stays the same.");
  });

  test("a repo-side delete removes the page — matches the engine's own hard-delete behavior", async () => {
    const repo = initTestRepo();
    writeRuleFile(repo, "rules/delete-me.md", approvedFrontmatter({ title: "Delete target" }), "Gone soon.");
    commitAll(repo, "seed");

    const store = freshNativeStore();
    await store.init({ engine: "postgres", orgId: `org-native-sync-delete-${RUN_ID}` });
    await store.syncGithubSource(`org-native-sync-delete-${RUN_ID}`, repo, "x");
    expect(await store.getPage("rules/delete-me", { orgId: `org-native-sync-delete-${RUN_ID}` })).not.toBeNull();

    rmSync(join(repo, "rules/delete-me.md"));
    commitAll(repo, "delete");

    const result = await store.syncGithubSource(`org-native-sync-delete-${RUN_ID}`, repo, "x");
    expect(result.status).toBe("synced");
    expect(result.deleted).toBe(1);
    expect(await store.getPage("rules/delete-me", { orgId: `org-native-sync-delete-${RUN_ID}` })).toBeNull();
  });

  test("org isolation: syncing org A's repo never creates or touches org B's rows", async () => {
    const repoA = initTestRepo();
    writeRuleFile(repoA, "rules/shared-name.md", approvedFrontmatter({ title: "Org A version" }), "Org A body.");
    commitAll(repoA, "seed a");

    // One store instance, two different orgIds passed per-call -- exactly
    // how the HTTP layer shares one process-lifetime store across every
    // org (see store.ts's own comments on this). Isolation has to come
    // entirely from the sourceId each call derives from its own orgId
    // argument, not from which store object issued the call.
    const store = freshNativeStore();
    await store.init({ engine: "postgres", orgId: `org-native-sync-iso-a-${RUN_ID}` });
    const result = await store.syncGithubSource(`org-native-sync-iso-a-${RUN_ID}`, repoA, "x");
    expect(result.added).toBe(1);

    const listedB = await store.listPages({ status: "approved", orgId: `org-native-sync-iso-b-${RUN_ID}` });
    expect(listedB).toHaveLength(0);
    expect(await store.getPage("rules/shared-name", { orgId: `org-native-sync-iso-b-${RUN_ID}` })).toBeNull();

    const listedA = await store.listPages({ status: "approved", orgId: `org-native-sync-iso-a-${RUN_ID}` });
    expect(listedA.map((r) => r.slug)).toContain("rules/shared-name");
  });
});

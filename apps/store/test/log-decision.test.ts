import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import { NativeStore } from "../src/native/store.ts";
import { hashApprovalContent, signApproval } from "../src/core/approval-signing.ts";
import type { RulePage } from "../src/core/store.ts";
import { fakeEmbed } from "./fake-embed.ts";
import { fakeRerank } from "./fake-rerank.ts";

/**
 * The escalation flywheel Phase 6 calls the thing to get right: a
 * no_rule_found decision must not just get logged and forgotten — it has
 * to turn into a real draft rule a human can review, or the same gap
 * silently repeats forever. composeLogDecision (core/log-decision.ts) is
 * pure composition of getPage/putPage/appendAudit, so it needs a real
 * store to exercise, run here against Postgres like native-store.test.ts's
 * own suite — see that file's header comment for why this needs a real
 * DATABASE_URL and skips cleanly in CI without one.
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

const SECRET = "test-only-log-decision-secret";

function makeApprovedRule(org: string, slug: string): RulePage {
  return {
    slug,
    org,
    title: "Refund window",
    body: "Customer requests a refund after 30 days: issue store credit.",
    status: "approved",
    confidence: 0.9,
    ownerId: "admin",
    sourceCitations: [],
    source: null,
    tags: [],
    lastValidatedAt: null,
    version: 1,
    supersededBy: null,
    previousVersionId: null,
    approvedBy: "admin",
    approvedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    prNumber: null,
    prUrl: null,
  };
}

async function freshStore(orgId: string): Promise<NativeStore> {
  process.env.DATABASE_URL = DATABASE_URL;
  const store = new NativeStore(fakeEmbed, fakeRerank);
  await store.init({ engine: "postgres", orgId });
  return store;
}

describe.skipIf(!reachable)("logDecision", () => {
  test("no_rule_found creates a draft escalation rule and returns its slug", async () => {
    const org = "org-decision-a";
    const store = await freshStore(org);

    const receipt = await store.logDecision({
      org,
      ruleSlug: null,
      keyId: "key-1",
      situationSummary: "Customer wants a refund after 90 days for a subscription product",
      actionTaken: "Escalated to a human — no matching rule",
      outcome: "no_rule_found",
    });

    expect(receipt.escalationSlug).not.toBeNull();
    const escalation = await store.getPage(receipt.escalationSlug as string, { orgId: org });
    expect(escalation).not.toBeNull();
    expect(escalation?.status).toBe("draft");
    expect(escalation?.tags).toContain("escalation");
    expect(escalation?.body).toContain("90 days for a subscription product");

    // The draft must never be reachable by search (approved-only) or by
    // getPage under any other org — same isolation and approval-gate
    // guarantees as every other rule.
    const hits = await store.search("refund after 90 days", { orgId: org, status: "approved" });
    expect(hits.some((h) => h.slug === receipt.escalationSlug)).toBe(false);
  });

  test("followed/escalated outcomes attach to the existing rule's timeline, no escalation created", async () => {
    const org = "org-decision-b";
    const store = await freshStore(org);
    const rule = makeApprovedRule(org, "rules/decision-b-fixture");
    process.env.GNT_APPROVAL_SIGNING_SECRET = SECRET;
    const signature = signRule(rule, SECRET);
    await store.putPage(rule, { approvalSignature: signature });

    const receipt = await store.logDecision({
      org,
      ruleSlug: rule.slug,
      keyId: "key-2",
      situationSummary: "Customer asked about a refund after 45 days",
      actionTaken: "Issued store credit per the rule",
      outcome: "followed",
    });

    expect(receipt.escalationSlug).toBeNull();

    const trail = await store.getAuditTrail(rule.slug, { orgId: org });
    expect(trail.some((e) => e.action === "decision_logged")).toBe(true);
    expect(trail.find((e) => e.action === "decision_logged")?.after.outcome).toBe("followed");
  });

  test("no_rule_found escalation is isolated per org, same as any other rule", async () => {
    // One shared store across both orgs — two separate stores would
    // "isolate" trivially without exercising the actual sourceId-scoping
    // logic at all.
    const orgA = "org-decision-c1";
    const orgB = "org-decision-c2";
    const store = await freshStore(orgA);

    const receipt = await store.logDecision({
      org: orgA,
      ruleSlug: null,
      keyId: "key-3",
      situationSummary: "org A's confidential gap",
      actionTaken: "escalated",
      outcome: "no_rule_found",
    });

    const crossRead = await store.getPage(receipt.escalationSlug as string, { orgId: orgB });
    expect(crossRead).toBeNull();

    const ownRead = await store.getPage(receipt.escalationSlug as string, { orgId: orgA });
    expect(ownRead).not.toBeNull();
  });
});

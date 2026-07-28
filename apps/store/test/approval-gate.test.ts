import { describe, expect, test } from "bun:test";
import type { RulePage } from "../src/core/store.ts";
import {
  ApprovalRejectedError,
  assertApprovedWriteIsSigned,
  hashApprovalContent,
  signApproval,
} from "../src/core/approval-signing.ts";

/**
 * Migration ground rule 5: "You do not auto-approve rules, ever."
 * assertApprovedWriteIsSigned is the single, adapter-agnostic
 * implementation of that gate — every storage adapter's putPage calls it
 * before writing anything, so it's tested directly here rather than
 * through a concrete store. A page write with status: "approved" must be
 * rejected unless it carries a signature that verifies against
 * GNT_APPROVAL_SIGNING_SECRET; every other status is unrestricted
 * (extraction writes drafts freely).
 */

const SECRET = "test-only-approval-gate-secret";

function signRule(rule: RulePage, secret: string): string {
  const contentHash = hashApprovalContent({
    title: rule.title,
    body: rule.body,
    tags: rule.tags,
    status: rule.status,
  });
  return signApproval({ org: rule.org, slug: rule.slug, version: rule.version, contentHash }, secret);
}

function makeRule(overrides: Partial<RulePage> = {}): RulePage {
  return {
    slug: "rules/approval-gate-fixture",
    org: "org-gate",
    title: "Refund window",
    body: "Customer requests a refund after 30 days: issue store credit instead of a cash refund.",
    status: "draft",
    confidence: 0.9,
    ownerId: "admin@org-gate.test",
    sourceCitations: [{ source_type: "capture", source_id: "evt-1" }],
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

describe("assertApprovedWriteIsSigned (GntStore.putPage's approval gate)", () => {
  test("draft/in_review/deprecated pass without any signature", () => {
    for (const status of ["draft", "in_review", "deprecated"] as const) {
      const rule = makeRule({ slug: `rules/status-${status}`, status });
      expect(() => assertApprovedWriteIsSigned(rule, undefined)).not.toThrow();
    }
  });

  test("approved status with no signature is rejected", () => {
    process.env.GNT_APPROVAL_SIGNING_SECRET = SECRET;
    const rule = makeRule({ status: "approved" });
    expect(() => assertApprovedWriteIsSigned(rule, undefined)).toThrow(ApprovalRejectedError);
  });

  test("approved status with a wrong signature is rejected", () => {
    process.env.GNT_APPROVAL_SIGNING_SECRET = SECRET;
    const rule = makeRule({ status: "approved" });
    expect(() => assertApprovedWriteIsSigned(rule, "0".repeat(64))).toThrow(ApprovalRejectedError);
  });

  test("approved status signed with a DIFFERENT secret is rejected", () => {
    process.env.GNT_APPROVAL_SIGNING_SECRET = SECRET;
    const rule = makeRule({ status: "approved" });
    const signature = signRule(rule, "a-completely-different-secret");
    expect(() => assertApprovedWriteIsSigned(rule, signature)).toThrow(ApprovalRejectedError);
  });

  test("approved status is rejected even with a valid-shaped signature if the env secret is unset", () => {
    delete process.env.GNT_APPROVAL_SIGNING_SECRET;
    const rule = makeRule({ status: "approved" });
    // Computed against a secret that no longer matches anything the gate
    // can check against — this must fail closed, not fail open.
    const signature = signRule(rule, "some-secret-the-gate-no-longer-knows");
    expect(() => assertApprovedWriteIsSigned(rule, signature)).toThrow(ApprovalRejectedError);
  });

  test("approved status with a valid signature succeeds", () => {
    process.env.GNT_APPROVAL_SIGNING_SECRET = SECRET;
    const rule = makeRule({ status: "approved", approvedAt: new Date().toISOString() });
    const signature = signRule(rule, SECRET);
    expect(() => assertApprovedWriteIsSigned(rule, signature)).not.toThrow();
  });

  test("a signature computed for a different slug/version does not authorize this write", () => {
    process.env.GNT_APPROVAL_SIGNING_SECRET = SECRET;
    const rule = makeRule({ status: "approved", version: 2 });
    // Signed for version 1, but the write is for version 2 — must not
    // authorize a bump to a version the signer never approved.
    const staleSignature = signRule({ ...rule, version: 1 }, SECRET);
    expect(() => assertApprovedWriteIsSigned(rule, staleSignature)).toThrow(ApprovalRejectedError);
  });

  test("a signature computed for different rule content does not authorize this write", () => {
    process.env.GNT_APPROVAL_SIGNING_SECRET = SECRET;
    const rule = makeRule({ status: "approved" });
    // Signed for the same org/slug/version, but over DIFFERENT body text —
    // the exact attack the content hash exists to close: a valid signature
    // for this slug/version must not authorize swapped-in content.
    const signature = signRule({ ...rule, body: "issue a full cash refund, no questions asked" }, SECRET);
    expect(() => assertApprovedWriteIsSigned(rule, signature)).toThrow(ApprovalRejectedError);
  });
});

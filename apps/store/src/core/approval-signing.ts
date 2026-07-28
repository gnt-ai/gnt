/**
 * Enforcement mechanism for one of the migration plan's non-negotiable
 * rules: "You do not auto-approve rules, ever." The status transitions
 * draft -> submitted -> approved/rejected are owned exclusively by the
 * approval service (Phase 4) — this is the gate GntStore.putPage checks
 * before accepting any page write that sets status: "approved".
 *
 * Phase 4 doesn't exist yet, so nothing currently holds
 * GNT_APPROVAL_SIGNING_SECRET except whatever calls signApproval() in a
 * test — that's expected. The gate has to exist before Phase 4 does, or
 * Phase 4 would be the first and only thing ever checking it, i.e. no
 * gate at all until someone remembers to add one.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { RulePage } from "./store.ts";

/** The fields that define what an approver actually approved. Anything
 * that changes the meaning of the rule must be in here — if it can change
 * without invalidating the signature, the signature isn't really binding
 * approval to content, just to a slug/version pair someone could reuse
 * with different content underneath it. */
export interface ApprovalContent {
  title: string;
  body: string;
  tags: string[];
  status: string;
}

const FIELD_SEP = "\u0000";
const TAG_SEP = "\u0001";

/** NUL/SOH-separated, not a plain joiner like " " or "," — those let two
 * different (title, body, tags) tuples canonicalize to the same string
 * (e.g. title "a b" + body "c" vs. title "a" + body "b c"). NUL/SOH
 * essentially never appear in rule text, so they're unambiguous delimiters
 * — but rule content is untrusted (extraction output, admin input), so
 * that assumption is enforced, not just hoped for: a field that DID
 * contain one would reopen the exact same collision the delimiter choice
 * is supposed to close. Must match apps/api/src/gnt/approval.py's
 * hash_approval_content byte-for-byte. */
function canonicalizeContent(content: ApprovalContent): string {
  for (const field of [content.title, content.body, content.status, ...content.tags]) {
    if (field.includes(FIELD_SEP) || field.includes(TAG_SEP)) {
      throw new Error("approval content must not contain NUL or SOH characters");
    }
  }
  return [content.title, content.body, content.tags.join(TAG_SEP), content.status].join(FIELD_SEP);
}

export function hashApprovalContent(content: ApprovalContent): string {
  return createHash("sha256").update(canonicalizeContent(content), "utf8").digest("hex");
}

/** Distinct from a generic Error so callers (e.g. the internal HTTP API)
 * can tell "the approval gate refused this write" — a client error, 403 —
 * apart from a genuine server-side failure, which must still surface as a
 * 500 rather than being folded into the same status code. */
export class ApprovalRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRejectedError";
  }
}

export interface ApprovalPayload {
  org: string;
  slug: string;
  version: number;
  contentHash: string;
}

function canonicalize(payload: ApprovalPayload): string {
  return `${payload.org}:${payload.slug}:${payload.version}:${payload.contentHash}`;
}

export function signApproval(payload: ApprovalPayload, secret: string): string {
  return createHmac("sha256", secret).update(canonicalize(payload)).digest("hex");
}

/** Fails closed: a missing/empty secret or signature is never valid,
 * length mismatches are rejected before the constant-time compare (a
 * differing length would throw inside timingSafeEqual otherwise), and
 * comparison itself is constant-time to avoid a timing side-channel on
 * the signature check. */
export function verifyApprovalSignature(
  payload: ApprovalPayload,
  signature: string | undefined,
  secret: string | undefined,
): boolean {
  if (!signature || !secret) return false;
  const expected = signApproval(payload, secret);
  const expectedBuf = Buffer.from(expected, "hex");
  const gotBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== gotBuf.length) return false;
  return timingSafeEqual(expectedBuf, gotBuf);
}

/**
 * Shared by every storage adapter's putPage — "you do not auto-approve
 * rules, ever" is a single invariant with one correct implementation, not
 * one per adapter. No-ops for every status except "approved". Throws
 * ApprovalRejectedError (not a generic Error) so callers, e.g. the internal
 * HTTP API, can tell "the approval gate refused this write" apart from a
 * genuine server-side failure.
 */
export function assertApprovedWriteIsSigned(
  rule: RulePage,
  approvalSignature: string | undefined,
): void {
  if (rule.status !== "approved") return;
  const contentHash = hashApprovalContent({
    title: rule.title,
    body: rule.body,
    tags: rule.tags,
    status: rule.status,
  });
  const valid = verifyApprovalSignature(
    { org: rule.org, slug: rule.slug, version: rule.version, contentHash },
    approvalSignature,
    process.env.GNT_APPROVAL_SIGNING_SECRET,
  );
  if (!valid) {
    throw new ApprovalRejectedError(
      `putPage refused: writing status "approved" for ${rule.slug} requires a valid ` +
        "approvalSignature from the approval service. This is not a missing-feature " +
        "error to work around — see docs/migration/MIGRATE_FOR_AGENTS.md ground rule 5.",
    );
  }
}

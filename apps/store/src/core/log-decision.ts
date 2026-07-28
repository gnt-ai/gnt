/**
 * Shared by every storage adapter — logDecision is pure composition of
 * other GntStore methods (getPage/putPage/appendAudit) with no
 * storage-specific behavior of its own, so there's exactly one
 * implementation of the escalation-draft flow to keep correct rather than
 * one per adapter.
 */
import { randomUUID } from "node:crypto";
import type { DecisionLogReceipt, DecisionLogRequest, GntStore, RulePage } from "./store.ts";

export async function composeLogDecision(
  store: GntStore,
  entry: DecisionLogRequest,
): Promise<DecisionLogReceipt> {
  // Runtime guard for the boundary the type system can't reach — MCP/HTTP
  // callers hand us a plain JSON object, not a statically-checked
  // DecisionLogRequest. Without this, a caller could attach a decision to
  // an arbitrary/nonexistent slug, or (worse) to another org's rule, or
  // to a rule that isn't even approved yet.
  if (entry.outcome !== "no_rule_found") {
    const rule = await store.getPage(entry.ruleSlug, { orgId: entry.org });
    if (!rule || rule.status !== "approved") {
      throw new Error(
        `logDecision refused: "${entry.ruleSlug}" is not an approved rule for this org.`,
      );
    }
  }

  let escalationSlug: string | null = null;

  if (entry.outcome === "no_rule_found") {
    // The flywheel: a gap an agent hit becomes a draft rule a human can
    // turn into a real one, instead of the same gap silently recurring
    // on every future query. Drafts never need an approval signature.
    const now = new Date().toISOString();
    const escalation: RulePage = {
      slug: `rules/${randomUUID()}`,
      org: entry.org,
      title: entry.situationSummary.slice(0, 80) || "Escalated gap",
      body:
        `An agent asked about this situation and no approved rule matched it:\n\n` +
        `${entry.situationSummary}\n\nWhat the agent did instead: ${entry.actionTaken}`,
      status: "draft",
      confidence: 0,
      ownerId: `mcp-key:${entry.keyId}`,
      sourceCitations: [{ source_type: "escalation" }],
      source: null,
      tags: ["escalation"],
      lastValidatedAt: null,
      version: 1,
      supersededBy: null,
      previousVersionId: null,
      approvedBy: null,
      approvedAt: null,
      createdAt: now,
      prNumber: null,
      prUrl: null,
    };
    const { slug } = await store.putPage(escalation);
    escalationSlug = slug;
  }

  const targetSlug = entry.ruleSlug ?? escalationSlug;
  if (targetSlug) {
    // Reuses appendAudit's exact shape (action/actorId/before/after) so
    // getAuditTrail has exactly one JSON format to parse regardless of
    // which of the two producers — the approval service or an MCP tool
    // call — wrote the entry.
    await store.appendAudit({
      org: entry.org,
      ruleSlug: targetSlug,
      actorId: `mcp-key:${entry.keyId}`,
      action: "decision_logged",
      before: null,
      after: {
        outcome: entry.outcome,
        situationSummary: entry.situationSummary,
        actionTaken: entry.actionTaken,
      },
    });
  }

  return { escalationSlug };
}

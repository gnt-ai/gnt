/**
 * The seam. gnt code depends only on this interface, never on raw Postgres
 * access directly — enforced by the no-restricted-imports ESLint rule in
 * eslint.config.js, which confines `postgres` package imports to
 * src/native/.
 */

/**
 * Exactly the 4 states PR #11's reviewed Rule model persists — there is
 * no separate persisted "rejected" state. Rejecting sends a rule back to
 * "draft" (with a rejection reason recorded in the audit log's `after`
 * snapshot, not as a status value) — see routers/rules.py::reject_rule.
 */
export type RuleStatus = "draft" | "in_review" | "pending_merge" | "approved" | "deprecated";

/**
 * Deliberately opaque, not a fixed shape — this field has carried two
 * different provenance shapes over time, neither of which
 * this seam ever reads a field off of itself (see the one write site
 * that does, log-decision.ts's escalation-rule creation, which only ever
 * writes, never reads, its own literal): the original
 * source_type/source_id/permalink/captured_at shape (still written by
 * that same escalation path), and `gnt prebrain`'s extraction citations
 * (sourcePath/startLine/endLine/walker/excerpt — see
 * apps/cli/src/prebrain/extraction/types.ts's SourceCitation, unrelated
 * to this same-named type before this comment other than the name).
 * Matches apps/api's own CreateRuleRequest.source_citations, which has
 * "no fixed Pydantic sub-schema" for the identical reason — this is
 * provenance metadata a human or a future producer attaches, not
 * something this seam validates the internals of.
 */
export type SourceCitation = Record<string, unknown>;

/**
 * Mirrors PR #11's Rule model field-for-field (title/body/tags, not a
 * condition/action/exception triple) — that shape was a deliberate,
 * reviewed unification away from the older DecisionRule's rigid
 * structure (see db/models.py's Rule docstring), and Phase 4 preserves
 * PR #11's actual reviewed state machine, not an earlier illustrative
 * spec drafted before that unification landed.
 */
export interface RulePage {
  slug: string;
  org: string;
  title: string;
  body: string;
  status: RuleStatus;
  confidence: number;
  ownerId: string;
  sourceCitations: SourceCitation[];
  /** Free-text provenance a human/agent typed in at creation time — "a
   * Slack thread from 2026-07-10", a URL, a doc name. Distinct from
   * sourceCitations above (which expects a structured source_type/
   * source_id/permalink shape nothing populates automatically anymore,
   * since the capture pipeline that used to fill it in was retired).
   * Surfaced directly in the proposed PR's body, not just here. */
  source: string | null;
  tags: string[];
  lastValidatedAt: string | null;
  version: number;
  supersededBy: string | null;
  previousVersionId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  /** Set only while status is pending_merge — the open PR proposing this
   * rule for merge. Null once approved (the git history is the record at
   * that point) or if the rule never left engine-pages-only draft/review. */
  prNumber: number | null;
  prUrl: string | null;
}

export interface ScoredRule extends RulePage {
  similarity: number;
}

export interface AuditEntry {
  org: string;
  ruleSlug: string;
  actorId: string;
  /** "decision_logged" is logDecision's own entry — same shape as every
   * other audit action (before/after), not a separate ad-hoc format, so
   * getAuditTrail's parser has exactly one shape to read regardless of
   * which of the two producers (the approval service, or an MCP tool
   * call) wrote it. "privacy_gate_masked" is the same pattern again (fix-
   * plan-v3 3.0): apps/api's create_draft_rule writes one whenever the
   * server-side privacy gate masks anything on the webhook-ingest path,
   * `after` carrying that gate's redaction record (kind/layer counts and
   * per-item breakdown, never a real value — see apps/api's
   * pipeline/privacy_gate/redaction_record.py). */
  action:
    | "created"
    | "submitted"
    | "proposed"
    | "approved"
    | "rejected"
    | "deprecated"
    | "decision_logged"
    | "privacy_gate_masked";
  /** Full serialized rule snapshots, matching routers/rules.py's
   * `_serialize(rule)` before/after pattern exactly — not a computed
   * diff, so the audit trail always shows complete state on both sides
   * of a transition. */
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
}

export type SourceKind = "slack" | "doc" | "capture" | "escalation";

export interface IngestBatch {
  org: string;
  sourceKind: SourceKind;
  text: string;
  /** Deterministic reference this batch's extracted rules should cite. */
  ref: string;
}

export interface IngestReceipt {
  org: string;
  draftSlugs: string[];
}

export interface StoreHealth {
  ok: boolean;
  engine: "pglite" | "postgres";
  pageCount: number;
}

export interface AuditLogEntry {
  action: string;
  actorId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  recordedAt: string;
}

export type DecisionOutcome = "followed" | "escalated" | "no_rule_found";

interface DecisionLogBase {
  org: string;
  keyId: string;
  situationSummary: string;
  actionTaken: string;
}

/**
 * Discriminated on outcome so the compiler enforces the same invariant the
 * store validates at runtime: "no_rule_found" never carries a ruleSlug
 * (there's no rule to attribute the decision to), and "followed"/"escalated"
 * always do (an unattributed decision claiming to follow or escalate a
 * rule is meaningless — see log-decision.ts's composeLogDecision for the
 * runtime check at the boundary where input isn't statically known, e.g.
 * from MCP/HTTP).
 */
export type DecisionLogRequest =
  | (DecisionLogBase & { outcome: "no_rule_found"; ruleSlug: null })
  | (DecisionLogBase & { outcome: "followed" | "escalated"; ruleSlug: string });

export interface DecisionLogReceipt {
  /** Set only when outcome was "no_rule_found" — the new draft escalation
   * page created so the gap enters the approval queue. */
  escalationSlug: string | null;
}

export interface GntStore {
  init(opts: { engine: "pglite" | "postgres"; orgId: string }): Promise<void>;
  health(): Promise<StoreHealth>;

  /**
   * `approvalSignature` is REQUIRED whenever `page.status === "approved"`
   * — the store must reject the write (not silently downgrade the
   * status) without a signature that verifies against
   * GNT_APPROVAL_SIGNING_SECRET. Every other status is unrestricted:
   * extraction may freely write draft, and the approval service owns the
   * submitted/rejected/deprecated transitions by convention (only
   * "approved" gets a cryptographic gate — see
   * docs/migration/MIGRATE_FOR_AGENTS.md Phase 3).
   */
  putPage(page: RulePage, opts?: { approvalSignature?: string }): Promise<{ slug: string }>;
  getPage(slug: string, opts: { orgId: string }): Promise<RulePage | null>;
  listPages(filter: { type?: string; status?: RuleStatus; orgId: string }): Promise<RulePage[]>;

  /** status filter is MANDATORY — the type does not allow an unfiltered query. */
  search(query: string, filter: { orgId: string; status: "approved" }): Promise<ScoredRule[]>;

  appendAudit(entry: AuditEntry): Promise<void>;
  /** Oldest first — matches the order a compliance review would want to
   * read a rule's history in. */
  getAuditTrail(ruleSlug: string, opts: { orgId: string }): Promise<AuditLogEntry[]>;
  ingest(source: IngestBatch): Promise<IngestReceipt>;

  /**
   * Org offboarding: hard-deletes this org's entire rules mirror — every
   * page, chunk, and embedding under its
   * source row, cascading via the schema's own FK constraints. A no-op
   * returning pagesDeleted: 0 if the org never wrote a rule (no source was
   * ever bootstrapped for it), not an error — an org with zero rules is a
   * legitimate, empty-result case for offboarding, not a failure.
   * Irreversible; callers are responsible for exporting whatever they need
   * before calling this.
   */
  deleteOrgSource(orgId: string): Promise<{ pagesDeleted: number }>;

  /**
   * The MCP serving layer's flywheel (Phase 6): every log_decision call
   * records what an agent did with a rule (or didn't have one for). When
   * outcome is "no_rule_found", this also creates a new draft rule page
   * (source.kind: escalation) so the gap surfaces in the approval queue
   * instead of silently repeating forever.
   */
  logDecision(entry: DecisionLogRequest): Promise<DecisionLogReceipt>;
}

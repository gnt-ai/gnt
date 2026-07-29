/**
 * Native Postgres/pgvector GntStore adapter — gnt's own schema (./schema.ts),
 * CRUD, hybrid search, and git-native sync, no third-party knowledge-store
 * dependency.
 *
 * search() runs the full native hybrid pipeline (./search.ts): pgvector
 * cosine + Postgres full-text search, fused via reciprocal-rank fusion,
 * cosine re-scored, title-boosted, deduped, cross-encoder reranked
 * (./rerank.ts), then a free-text alias hop. It deliberately does NOT
 * implement salience, recency, backlink/chronicle/graph-signal boosts,
 * relational recall, autocut, adaptive-return sizing, contextual
 * retrieval, or a semantic query cache — those either require signals
 * this store never populates for a rules corpus (salience scores, typed
 * edges, backlinks) or are result-sizing heuristics layered on top of the
 * core ranking rather than part of it. The eval-gated cutover is where
 * that scope call got checked against real numbers (see CUTOVER.md).
 *
 * syncGithubSource() imports a cloned rules repo via ./sync.ts — see that
 * file's header comment for what it does and its scope decisions.
 */

import postgres from "postgres";
import type {
  AuditEntry,
  AuditLogEntry,
  DecisionLogReceipt,
  DecisionLogRequest,
  GntStore,
  IngestBatch,
  IngestReceipt,
  RulePage,
  RuleStatus,
  ScoredRule,
  StoreHealth,
} from "../core/store.ts";
import { assertApprovedWriteIsSigned } from "../core/approval-signing.ts";
import { composeLogDecision } from "../core/log-decision.ts";
import { normalizeSourceId, cloneDirFor } from "../core/source-paths.ts";
import { cloneOrPull } from "../core/github-clone.ts";
import { bootstrapNativeSchema } from "./schema.ts";
import { nativeHybridSearch, toVectorLiteral } from "./search.ts";
import { zeroEntropyRerank, type RerankFn } from "./rerank.ts";
import { nativeSync, type NativeSyncResult } from "./sync.ts";

export const RULE_PAGE_TYPE = "rule";

// Matches EngineStore's own constant — content_chunks.model is informational
// only (nothing in this codebase reads it back), but keeping the value
// consistent across adapters avoids confusion when eyeballing rows written
// by either one.
export const EMBEDDING_MODEL = "zeroentropyai:zembed-1";

// Matches EngineStore's own RERANKER_MODEL/RERANKER_ENABLED — the founder's
// 2026-07-17 decision to ship the reranker on for every org regardless of
// corpus size (see EngineStore's own comment for the accepted small-scale
// tradeoff). This store enforces it the same way: the stage always runs,
// gated only by which `rerankFn` the caller wired up (see the constructor
// comment below), not by a second enabled/disabled switch in here.
const RERANKER_MODEL = "zeroentropyai:zerank-2";
const RERANKER_ENABLED = true;

export type EmbedFn = (text: string) => Promise<Float32Array>;
export type PgSql = ReturnType<typeof postgres>;

/**
 * Shared page+chunk upsert — the transactional write both putPage (below)
 * and native/sync.ts's per-file import go through, so a page looks
 * identical regardless of whether it arrived via a direct API write or a
 * git sync. Deliberately does NOT enforce the approval-signature gate —
 * that's putPage's caller-facing contract, not this shared plumbing's;
 * sync.ts bypasses it on purpose (see that file's header comment for why).
 */
export async function upsertRulePageRow(
  sql: PgSql,
  params: {
    sourceId: string;
    slug: string;
    title: string;
    compiledTruth: string;
    frontmatter: Record<string, unknown>;
    embeddingLiteral: string;
    /** null for putPage's own writes (no change-detection use for them yet). */
    contentHash: string | null;
  },
): Promise<{ slug: string }> {
  const { sourceId, slug, title, compiledTruth, frontmatter, embeddingLiteral, contentHash } = params;
  await sql.begin(async (tx) => {
    const rows = await tx<{ id: number }[]>`
      INSERT INTO pages (source_id, slug, type, title, compiled_truth, frontmatter, content_hash, updated_at)
      VALUES (${sourceId}, ${slug}, ${RULE_PAGE_TYPE}, ${title}, ${compiledTruth}, ${tx.json(frontmatter as Parameters<typeof tx.json>[0])}, ${contentHash}, now())
      ON CONFLICT (source_id, slug) DO UPDATE SET
        title = EXCLUDED.title,
        compiled_truth = EXCLUDED.compiled_truth,
        frontmatter = EXCLUDED.frontmatter,
        content_hash = EXCLUDED.content_hash,
        updated_at = now()
      RETURNING id
    `;
    const pageId = rows[0].id;
    await tx`
      INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, embedding, model, embedded_at)
      VALUES (${pageId}, 0, ${compiledTruth}, 'compiled_truth', ${embeddingLiteral}::vector, ${EMBEDDING_MODEL}, now())
      ON CONFLICT (page_id, chunk_index) DO UPDATE SET
        chunk_text = EXCLUDED.chunk_text,
        chunk_source = EXCLUDED.chunk_source,
        embedding = EXCLUDED.embedding,
        model = EXCLUDED.model,
        embedded_at = EXCLUDED.embedded_at
    `;
  });
  return { slug };
}

export class NativeStore implements GntStore {
  #sql: PgSql | null = null;
  #embed: EmbedFn;
  #rerank: RerankFn;

  /**
   * Unlike EngineStore, there is no default provider-backed embedFn here —
   * a live embedding call is a separate concern this task doesn't
   * implement. Every caller (server.ts, tests) must pass one explicitly: a
   * real provider function in production, a deterministic fake under
   * GNT_STORE_TEST_FAKE_EMBED.
   *
   * `rerankFn` DOES default to a real provider-backed transport
   * (zeroEntropyRerank) — the same convention EngineStore's own embedFn
   * default uses (`embedFn = embedQuery`) — so production callers get a
   * working reranker with no extra wiring. Every test/eval call site must
   * override it explicitly with a fake or a fixture replay (tests must
   * never make real paid API calls); the existing test suite
   * already follows that convention for embedFn and this mirrors it.
   */
  constructor(embedFn: EmbedFn, rerankFn: RerankFn = zeroEntropyRerank) {
    this.#embed = embedFn;
    this.#rerank = rerankFn;
  }

  async init(opts: { engine: "pglite" | "postgres"; orgId: string }): Promise<void> {
    if (opts.engine !== "postgres") {
      throw new Error(
        `NativeStore.init() only supports engine: "postgres" (got "${opts.engine}") — ` +
          "the native adapter has no in-memory/PGLite mode.",
      );
    }
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("NativeStore.init() requires DATABASE_URL to be set.");
    }
    // onnotice silences NOTICE-level chatter from the idempotent DDL replay
    // below (every CREATE ... IF NOT EXISTS against existing objects emits
    // one). connect_timeout: an unreachable/misconfigured host must fail
    // loud and fast, not hang init() (and therefore the whole server
    // process, and http/server.ts's health check) forever — the `postgres`
    // package has no timeout by default.
    this.#sql = postgres(databaseUrl, { onnotice: () => {}, connect_timeout: 10 });
    await bootstrapNativeSchema(this.#sql);
    await this.#ensureSource(opts.orgId);
  }

  #requireSql(): PgSql {
    if (!this.#sql) throw new Error("NativeStore.init() must be called before use.");
    return this.#sql;
  }

  async #ensureSource(orgId: string): Promise<void> {
    const sql = this.#requireSql();
    const sourceId = normalizeSourceId(orgId);
    const existing = await sql`SELECT id FROM sources WHERE id = ${sourceId}`;
    if (existing.length > 0) return;
    // ON CONFLICT DO NOTHING: two concurrent first-writes for the same new
    // org could otherwise race between the SELECT above and this INSERT.
    await sql`
      INSERT INTO sources (id, name) VALUES (${sourceId}, ${orgId})
      ON CONFLICT (id) DO NOTHING
    `;
  }

  /**
   * sources_add equivalent — bootstraps or updates the org's source row
   * with its cloned rules-repo path. Mirrors EngineStore.registerGithubSource
   * exactly (same clone helper, same lazily-bootstrapped-source handling)
   * since this is apps/store's own logic, not the engine's.
   */
  async registerGithubSource(orgId: string, repoUrl: string, pat: string): Promise<void> {
    const sql = this.#requireSql();
    const sourceId = normalizeSourceId(orgId);
    const destDir = cloneDirFor(sourceId);
    await cloneOrPull(repoUrl, pat, destDir);

    const existing = await sql`SELECT id FROM sources WHERE id = ${sourceId}`;
    if (existing.length > 0) {
      await sql`UPDATE sources SET local_path = ${destDir} WHERE id = ${sourceId}`;
      return;
    }
    await sql`INSERT INTO sources (id, name, local_path) VALUES (${sourceId}, ${orgId}, ${destDir})`;
  }

  /**
   * Clones (or pulls) the org's connected repo — same auth-bearing helper
   * registerGithubSource uses, so a stale/never-registered source gets
   * re-established here too — then imports whatever changed via
   * native/sync.ts. Same return-shape contract as EngineStore's version
   * (a JSON-serializable result object; see sync.ts's NativeSyncResult):
   * the one caller (apps/api's store_client.sync_github_source) only checks
   * the HTTP status and otherwise treats the body as opaque.
   */
  async syncGithubSource(orgId: string, repoUrl: string, pat: string): Promise<NativeSyncResult> {
    const sourceId = normalizeSourceId(orgId);
    const destDir = cloneDirFor(sourceId);
    await this.registerGithubSource(orgId, repoUrl, pat);
    const sql = this.#requireSql();
    return nativeSync(sql, this.#embed, { orgId, sourceId, repoPath: destDir });
  }

  async health(): Promise<StoreHealth> {
    const sql = this.#requireSql();
    // Intentionally global, not per-org — see GntStore.health()'s own
    // contract (a liveness/ops metric, e.g. the unauthenticated /health
    // route), a deliberate cross-tenant count, not a scoping bug.
    const rows = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pages WHERE type = ${RULE_PAGE_TYPE} AND deleted_at IS NULL
    `;
    return { ok: true, engine: "postgres", pageCount: rows[0]?.count ?? 0 };
  }

  async putPage(rule: RulePage, opts?: { approvalSignature?: string }): Promise<{ slug: string }> {
    assertApprovedWriteIsSigned(rule, opts?.approvalSignature);

    const sql = this.#requireSql();
    // Lazily bootstraps rule.org's source on first write — same convention
    // as EngineStore: one running NativeStore serves every org over its
    // process lifetime, not one instance per org.
    await this.#ensureSource(rule.org);
    const sourceId = normalizeSourceId(rule.org);
    const slug = rule.slug.toLowerCase();
    const title = rule.title.slice(0, 80) || slug;
    const compiledTruth = `${rule.title}\n\n${rule.body}`;
    const frontmatter = {
      org: rule.org,
      title: rule.title,
      body: rule.body,
      status: rule.status,
      confidence: rule.confidence,
      owner_id: rule.ownerId,
      source_citations: rule.sourceCitations,
      source: rule.source,
      tags: rule.tags,
      last_validated_at: rule.lastValidatedAt,
      version: rule.version,
      superseded_by: rule.supersededBy,
      previous_version_id: rule.previousVersionId,
      approved_by: rule.approvedBy,
      approved_at: rule.approvedAt,
      created_at: rule.createdAt,
      pr_number: rule.prNumber,
      pr_url: rule.prUrl,
    };

    // Embed BEFORE writing anything: this is the call most likely to fail
    // (a remote embedding API), and doing it first means a failure here
    // leaves no partial state at all, rather than a page row that's
    // gettable/listable but silently invisible to search().
    const embeddingLiteral = toVectorLiteral(await this.#embed(compiledTruth));

    // Page + chunk upsert in one transaction — without this, a failure
    // between the two writes would commit the page row while leaving it
    // unsearchable, with no way to tell from the caller's side that the
    // write is only half-done.
    return upsertRulePageRow(sql, {
      sourceId,
      slug,
      title,
      compiledTruth,
      frontmatter,
      embeddingLiteral,
      contentHash: null,
    });
  }

  async getPage(slug: string, opts: { orgId: string }): Promise<RulePage | null> {
    const sql = this.#requireSql();
    const sourceId = normalizeSourceId(opts.orgId);
    const rows = await sql`
      SELECT id, slug, title, compiled_truth, frontmatter, created_at
      FROM pages
      WHERE slug = ${slug} AND source_id = ${sourceId} AND deleted_at IS NULL
      LIMIT 1
    `;
    return rows.length > 0 ? this.#rowToRule(sql, rows[0]) : null;
  }

  async listPages(filter: { type?: string; status?: RuleStatus; orgId: string }): Promise<RulePage[]> {
    const sql = this.#requireSql();
    const sourceId = normalizeSourceId(filter.orgId);
    const rows = await sql`
      SELECT id, slug, title, compiled_truth, frontmatter, created_at
      FROM pages
      WHERE source_id = ${sourceId} AND type = ${filter.type ?? RULE_PAGE_TYPE} AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `;
    const rules = await Promise.all(rows.map((row) => this.#rowToRule(sql, row)));
    return filter.status ? rules.filter((r) => r.status === filter.status) : rules;
  }

  /**
   * Two independent write paths produce structurally different Page shapes
   * for the same rule data — this store's own writes (putPage above) stuff
   * title/body/tags inside frontmatter; the engine's own generic markdown
   * importer (a page this store can still READ, on a shared database)
   * strips tags OUT of frontmatter into the "tags" table instead. Preferring
   * the frontmatter copy and falling back to a real tags-table read only
   * changes behavior for pages written by that other path — this store's
   * own writes always populate frontmatter, so the fallback is dead code
   * for them. Mirrors EngineStore's pageToRule exactly.
   */
  async #rowToRule(sql: PgSql, row: Record<string, unknown>): Promise<RulePage> {
    const fm = (row.frontmatter ?? {}) as Record<string, unknown>;
    let tags = (fm.tags as string[] | undefined) ?? [];
    if (tags.length === 0) {
      const tagRows = await sql<{ tag: string }[]>`
        SELECT DISTINCT tag FROM tags WHERE page_id = ${row.id as number} ORDER BY tag
      `;
      tags = tagRows.map((r) => r.tag);
    }
    return {
      slug: row.slug as string,
      org: String(fm.org ?? ""),
      title: String(fm.title ?? row.title ?? ""),
      body: String(fm.body ?? row.compiled_truth ?? ""),
      status: (fm.status as RuleStatus) ?? "draft",
      confidence: Number(fm.confidence ?? 0),
      ownerId: String(fm.owner_id ?? ""),
      sourceCitations: (fm.source_citations as RulePage["sourceCitations"]) ?? [],
      source: (fm.source as string | null) ?? null,
      tags,
      lastValidatedAt: (fm.last_validated_at as string | null) ?? null,
      version: Number(fm.version ?? 1),
      supersededBy: (fm.superseded_by as string | null) ?? null,
      previousVersionId: (fm.previous_version_id as string | null) ?? null,
      approvedBy: (fm.approved_by as string | null) ?? null,
      approvedAt: (fm.approved_at as string | null) ?? null,
      createdAt: String(fm.created_at ?? (row.created_at as Date | undefined)?.toISOString?.() ?? ""),
      prNumber: (fm.pr_number as number | null) ?? null,
      prUrl: (fm.pr_url as string | null) ?? null,
    };
  }

  /**
   * status is typed as the literal "approved" — there is no calling
   * convention that lets this method return anything else.
   *
   * Runs the full native hybrid pipeline (./search.ts) scoped to this
   * org's source, then re-fetches each hit's full page row and filters to
   * approved — see this file's header comment for what the pipeline does
   * and deliberately doesn't reproduce.
   */
  async search(query: string, filter: { orgId: string; status: "approved" }): Promise<ScoredRule[]> {
    const sql = this.#requireSql();
    const sourceId = normalizeSourceId(filter.orgId);

    const hits = await nativeHybridSearch(
      sql,
      this.#embed,
      this.#rerank,
      { enabled: RERANKER_ENABLED, topNIn: 25, topNOut: null, model: RERANKER_MODEL, timeoutMs: 5000 },
      query,
      sourceId,
    );

    const seen = new Set<string>();
    const out: ScoredRule[] = [];
    for (const hit of hits) {
      if (seen.has(hit.slug)) continue;
      seen.add(hit.slug);
      const rows = await sql`
        SELECT id, slug, title, compiled_truth, frontmatter, created_at
        FROM pages
        WHERE id = ${hit.pageId} AND source_id = ${sourceId} AND deleted_at IS NULL
        LIMIT 1
      `;
      if (rows.length === 0) continue;
      const rule = await this.#rowToRule(sql, rows[0]);
      // Defense in depth: the filter argument's type already forces
      // "approved" at every call site, but never trust storage-layer
      // status alone.
      if (rule.status !== filter.status) continue;
      out.push({ ...rule, similarity: hit.score });
    }
    return out;
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    const sql = this.#requireSql();
    const sourceId = normalizeSourceId(entry.org);
    const detail = JSON.stringify({
      org: entry.org,
      actorId: entry.actorId,
      action: entry.action,
      before: entry.before,
      after: entry.after,
    });
    await sql`
      INSERT INTO timeline_entries (page_id, date, source, summary, detail)
      SELECT id, now()::date, ${entry.actorId}, ${`${entry.action} by ${entry.actorId}`}, ${detail}
      FROM pages WHERE slug = ${entry.ruleSlug} AND source_id = ${sourceId}
      ON CONFLICT (page_id, date, summary, source) DO NOTHING
    `;
  }

  async getAuditTrail(ruleSlug: string, opts: { orgId: string }): Promise<AuditLogEntry[]> {
    const sql = this.#requireSql();
    const sourceId = normalizeSourceId(opts.orgId);
    const rows = await sql`
      SELECT te.detail, te.created_at
      FROM timeline_entries te
      JOIN pages p ON p.id = te.page_id
      WHERE p.slug = ${ruleSlug} AND p.source_id = ${sourceId}
      ORDER BY te.date DESC
    `;
    return rows
      .map((row) => {
        // detail is exactly the JSON.stringify'd object appendAudit wrote —
        // parse failures here would mean something else wrote to this
        // page's timeline, not a legitimate audit entry, so skip it
        // rather than throw and take the whole trail down.
        try {
          const parsed = JSON.parse(row.detail as string) as {
            action: string;
            actorId: string;
            before: Record<string, unknown> | null;
            after: Record<string, unknown>;
          };
          return {
            action: parsed.action,
            actorId: parsed.actorId,
            before: parsed.before,
            after: parsed.after,
            recordedAt: (row.created_at as Date).toISOString(),
          };
        } catch {
          return null;
        }
      })
      .filter((e): e is AuditLogEntry => e !== null)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  }

  async ingest(source: IngestBatch): Promise<IngestReceipt> {
    // Same scope note as EngineStore.ingest — extraction stays in gnt's own
    // pipeline; this exists on the interface for the webhook/inbox path
    // this store doesn't use yet.
    void source;
    return { org: source.org, draftSlugs: [] };
  }

  /**
   * Org offboarding. sources.id -> pages ON DELETE CASCADE (and pages.id ->
   * content_chunks/timeline_entries/tags ON DELETE CASCADE in turn) does
   * the actual cascading removal — deleting the one source row is
   * sufficient. Counts before deleting since the rows are gone by the time
   * a post-delete count could see them.
   */
  async deleteOrgSource(orgId: string): Promise<{ pagesDeleted: number }> {
    const sql = this.#requireSql();
    const sourceId = normalizeSourceId(orgId);
    const existing = await sql`SELECT id FROM sources WHERE id = ${sourceId}`;
    if (existing.length === 0) return { pagesDeleted: 0 };
    const countRows = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pages WHERE source_id = ${sourceId}
    `;
    await sql`DELETE FROM sources WHERE id = ${sourceId}`;
    return { pagesDeleted: countRows[0]?.count ?? 0 };
  }

  async logDecision(entry: DecisionLogRequest): Promise<DecisionLogReceipt> {
    return composeLogDecision(this, entry);
  }
}

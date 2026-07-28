/**
 * Native hybrid retrieval — pgvector cosine (vector arm) + Postgres
 * full-text search (keyword arm), fused via reciprocal-rank fusion, then
 * title/alias boosting, then a cross-encoder rerank pass. Reproduces the
 * shipped retrieval semantics: RRF_K=60, the compiled-truth-chunk boost,
 * the 0.7*rrf + 0.3*cosine re-score blend, the dedup pipeline's type-
 * diversity cap, a 1.25x title-phrase boost, and a free-text alias hop —
 * see NativeStore.search()'s own comment for the stages this deliberately
 * leaves out and why.
 *
 * Every query here is scoped by source_id — the multi-tenant isolation
 * boundary (see ../core/source-paths.ts::normalizeSourceId).
 */

import type postgres from "postgres";
import { applyReranker, type RerankFn, type RerankerOpts } from "./rerank.ts";

type PgSql = ReturnType<typeof postgres>;
type EmbedFn = (text: string) => Promise<Float32Array>;

export function toVectorLiteral(embedding: Float32Array): string {
  return `[${Array.from(embedding).join(",")}]`;
}

// Arm candidate-pool size. Mirrors the vendored engine's hybridSearch:
// innerLimit = min(FINAL_LIMIT * 2, 100), the pool each arm is asked for
// before fusion narrows it back down to FINAL_LIMIT.
const ARM_POOL_SIZE = 50;
// Final result count, matching EngineStore.search()'s own hybridSearch call.
const FINAL_LIMIT = 25;

const RRF_K = 60;
// Every chunk this store writes is chunk_source='compiled_truth' (one
// chunk per page — see store.ts's putPage), so this multiplies every
// candidate's score by the same constant. Kept for output-fidelity (the
// reported `similarity` number) even though it can never change relative
// order here the way it can in a corpus with mixed chunk sources.
const COMPILED_TRUTH_BOOST = 2.0;

// Title-phrase boost — reproduces the vendored engine's DEFAULT_TITLE_BOOST.
const TITLE_BOOST_FACTOR = 1.25;
const TITLE_STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "with",
  "at", "by", "from", "as", "is", "it", "this", "that", "my", "your",
]);
const TITLE_MIN_CONTENT_TOKENS = 2;

// Free-text alias hop tuning — reproduces the vendored engine's constants.
const ALIAS_HOP_PRESENT_BOOST = 1.1;
const MAX_ALIAS_QUERY_TOKENS = 6;
const MAX_ALIAS_INJECT = 3;

// Dedup pipeline's type-diversity layer: no page type may exceed this
// fraction of the candidate pool. The other three dedup layers (top-3-
// per-page, cross-page text-similarity, per-page cap) are structural
// no-ops here — putPage writes exactly one compiled_truth chunk per page,
// so there is never more than one chunk per page to dedupe within.
const MAX_TYPE_RATIO = 0.6;

interface Candidate {
  pageId: number;
  chunkId: number;
  slug: string;
  title: string;
  compiledTruth: string;
  score: number;
  rerankScore?: number;
  aliasHit?: boolean;
}

// `applyReranker` only needs chunkText/title/score/rerankScore — this
// adapter shape lets Candidate flow through it without a copy.
interface RerankView {
  chunkText: string;
  title: string;
  score: number;
  rerankScore?: number;
}

function asRerankView(c: Candidate): Candidate & RerankView {
  return Object.assign(c, { chunkText: c.compiledTruth });
}

async function vectorArm(sql: PgSql, sourceId: string, embeddingLiteral: string): Promise<Candidate[]> {
  const rows = await sql<
    { page_id: number; chunk_id: number; slug: string; title: string; compiled_truth: string }[]
  >`
    SELECT p.id AS page_id, c.id AS chunk_id, p.slug, p.title, p.compiled_truth
    FROM content_chunks c
    JOIN pages p ON p.id = c.page_id
    WHERE p.source_id = ${sourceId} AND p.deleted_at IS NULL
      AND c.embedding IS NOT NULL AND c.modality = 'text'
    ORDER BY c.embedding <=> ${embeddingLiteral}::vector
    LIMIT ${ARM_POOL_SIZE}
  `;
  return rows.map((r) => ({
    pageId: r.page_id,
    chunkId: r.chunk_id,
    slug: r.slug,
    title: r.title,
    compiledTruth: r.compiled_truth,
    score: 0,
  }));
}

async function keywordArm(sql: PgSql, sourceId: string, query: string): Promise<Candidate[]> {
  const rows = await sql<
    { page_id: number; chunk_id: number; slug: string; title: string; compiled_truth: string }[]
  >`
    SELECT p.id AS page_id, c.id AS chunk_id, p.slug, p.title, p.compiled_truth
    FROM content_chunks c
    JOIN pages p ON p.id = c.page_id
    WHERE p.source_id = ${sourceId} AND p.deleted_at IS NULL
      AND c.search_vector @@ websearch_to_tsquery('english', ${query})
    ORDER BY ts_rank(c.search_vector, websearch_to_tsquery('english', ${query})) DESC
    LIMIT ${ARM_POOL_SIZE}
  `;
  return rows.map((r) => ({
    pageId: r.page_id,
    chunkId: r.chunk_id,
    slug: r.slug,
    title: r.title,
    compiledTruth: r.compiled_truth,
    score: 0,
  }));
}

function rrfFuse(lists: Candidate[][]): Candidate[] {
  const scored = new Map<string, { c: Candidate; score: number }>();
  for (const list of lists) {
    list.forEach((c, rank) => {
      const key = `${c.slug}:${c.chunkId}`;
      const rrfScore = 1 / (RRF_K + rank);
      const existing = scored.get(key);
      if (existing) existing.score += rrfScore;
      else scored.set(key, { c, score: rrfScore });
    });
  }
  const entries = [...scored.values()];
  if (entries.length === 0) return [];
  const maxScore = Math.max(...entries.map((e) => e.score));
  const out = entries.map((e) => ({
    ...e.c,
    score: maxScore > 0 ? (e.score / maxScore) * COMPILED_TRUTH_BOOST : 0,
  }));
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** Blend RRF score with query-chunk cosine similarity — the same 0.7/0.3
 * split the vendored engine's cosineReScore used. Refetches cosine from
 * pgvector directly (`1 - (a <=> b)` for cosine ops IS cosine similarity)
 * rather than pulling raw vectors into JS. */
async function cosineRescore(
  sql: PgSql,
  candidates: Candidate[],
  embeddingLiteral: string,
): Promise<Candidate[]> {
  if (candidates.length === 0) return candidates;
  const chunkIds = candidates.map((c) => c.chunkId);
  const rows = await sql<{ id: number; cosine_sim: number }[]>`
    SELECT id, 1 - (embedding <=> ${embeddingLiteral}::vector) AS cosine_sim
    FROM content_chunks
    WHERE id = ANY(${chunkIds}::int[]) AND embedding IS NOT NULL
  `;
  const cosineById = new Map(rows.map((r) => [r.id, Number(r.cosine_sim)]));
  const maxRrf = Math.max(...candidates.map((c) => c.score));
  const out = candidates.map((c) => {
    const cosine = cosineById.get(c.chunkId);
    if (cosine === undefined) return c;
    const normRrf = maxRrf > 0 ? c.score / maxRrf : 0;
    return { ...c, score: 0.7 * normRrf + 0.3 * cosine };
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** Token boundaries: lowercase, NFKC, split on non-letter/digit runs. */
function tokenizeTitle(s: string): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function containsTokenRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** A query is a title-phrase match when it's the full normalized title, or
 * a contiguous token run inside it with >= 2 non-stopword tokens (blocks a
 * single stopword-ish fragment from boosting an unrelated page). */
function isTitlePhraseMatch(query: string, title: string): boolean {
  const qTokens = tokenizeTitle(query);
  const tTokens = tokenizeTitle(title);
  if (qTokens.length === 0 || tTokens.length === 0) return false;
  if (qTokens.length === tTokens.length && qTokens.every((t, i) => t === tTokens[i])) return true;
  const qContent = qTokens.filter((t) => !TITLE_STOPWORDS.has(t));
  if (qContent.length < TITLE_MIN_CONTENT_TOKENS) return false;
  return containsTokenRun(tTokens, qTokens);
}

function applyTitleBoost(candidates: Candidate[], query: string): void {
  if (!query) return;
  for (const c of candidates) {
    if (isTitlePhraseMatch(query, c.title)) c.score *= TITLE_BOOST_FACTOR;
  }
  candidates.sort((a, b) => b.score - a.score);
}

/** Dedup pipeline's type-diversity layer — the only one of the four that
 * isn't a structural no-op for this store (see MAX_TYPE_RATIO's comment).
 * Input must already be score-sorted; output preserves that order. */
function capByTypeDiversity(candidates: Candidate[]): Candidate[] {
  if (candidates.length === 0) return candidates;
  const cap = Math.max(1, Math.ceil(candidates.length * MAX_TYPE_RATIO));
  return candidates.slice(0, cap);
}

/** Same normalization the write side would use to populate an alias list
 * (NFKC, lowercase, collapsed whitespace, unwrapped quotes/brackets) —
 * this store has no write path for aliases yet, so this only ever matches
 * rows a shared production database's other write paths populated. */
function normalizeAlias(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`[(]+/, "")
    .replace(/["'`)\]]+$/, "")
    .trim();
}

/**
 * Free-text alias hop: if the query exactly (after normalization) matches
 * a page's declared alias, make sure that page surfaces — boost it if
 * it's already in the result set, inject it just above the current top
 * score otherwise. Fail-open: this store's own schema never creates
 * `page_aliases` (nothing here writes to it), so on a fresh native-only
 * database the query below throws and this no-ops; on a database the
 * vendored engine's own schema already created, it queries the same table
 * name/columns that schema uses, so a shared production database's
 * aliases (written by some other path) still work.
 */
async function applyAliasHop(
  sql: PgSql,
  sourceId: string,
  candidates: Candidate[],
  query: string,
): Promise<Candidate[]> {
  if (!query) return candidates;
  const qNorm = normalizeAlias(query);
  if (!qNorm || qNorm.split(" ").length > MAX_ALIAS_QUERY_TOKENS) return candidates;

  let refs: { slug: string }[];
  try {
    refs = await sql<{ slug: string }[]>`
      SELECT slug FROM page_aliases
      WHERE source_id = ${sourceId} AND alias_norm = ${qNorm}
      ORDER BY slug
    `;
  } catch {
    return candidates; // no page_aliases table (or a transient error) — fail-open
  }
  if (refs.length === 0) return candidates;

  const ordered = refs.slice(0, MAX_ALIAS_INJECT);
  const out = [...candidates];
  const topScore = out.reduce((m, c) => (Number.isFinite(c.score) && c.score > m ? c.score : m), 0);
  let injectScore = topScore > 0 ? topScore : 1.0;

  for (const ref of ordered) {
    const idx = out.findIndex((c) => c.slug === ref.slug);
    if (idx >= 0) {
      out[idx].score *= ALIAS_HOP_PRESENT_BOOST;
      out[idx].aliasHit = true;
      continue;
    }
    const rows = await sql<{ id: number; slug: string; title: string; compiled_truth: string }[]>`
      SELECT id, slug, title, compiled_truth FROM pages
      WHERE source_id = ${sourceId} AND slug = ${ref.slug} AND deleted_at IS NULL
      LIMIT 1
    `;
    const page = rows[0];
    if (!page) continue;
    injectScore += 1e-6;
    out.push({
      pageId: page.id,
      chunkId: -1,
      slug: page.slug,
      title: page.title,
      compiledTruth: page.compiled_truth,
      score: injectScore,
      aliasHit: true,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export interface NativeSearchResult {
  pageId: number;
  slug: string;
  score: number;
}

/**
 * Full native hybrid pipeline: vector arm + keyword arm -> RRF -> cosine
 * re-score -> title boost -> type-diversity dedup -> rerank -> alias hop
 * -> final slice. Returns ranked (pageId, slug, score) rows; the caller
 * (NativeStore.search()) fetches full page data and applies status
 * filtering + dedup-by-slug the same way it always has.
 */
export async function nativeHybridSearch(
  sql: PgSql,
  embed: EmbedFn,
  rerankFn: RerankFn,
  rerankerOpts: RerankerOpts,
  query: string,
  sourceId: string,
): Promise<NativeSearchResult[]> {
  const embeddingLiteral = toVectorLiteral(await embed(query));

  const [vectorList, keywordList] = await Promise.all([
    vectorArm(sql, sourceId, embeddingLiteral),
    keywordArm(sql, sourceId, query),
  ]);

  let fused = rrfFuse([vectorList, keywordList]);
  if (fused.length === 0) return [];

  fused = await cosineRescore(sql, fused, embeddingLiteral);
  applyTitleBoost(fused, query);

  const deduped = capByTypeDiversity(fused);
  const reranked = await applyReranker(
    query,
    deduped.map(asRerankView),
    rerankerOpts,
    rerankFn,
  );

  const hopped = await applyAliasHop(sql, sourceId, reranked, query);
  return hopped.slice(0, FINAL_LIMIT).map((c) => ({ pageId: c.pageId, slug: c.slug, score: c.score }));
}

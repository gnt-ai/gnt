/**
 * Cross-encoder rerank stage — ZeroEntropy zerank-2, same wire contract
 * used everywhere else this codebase reaches ZeroEntropy (see
 * ../adapters/engine/store.ts's EMBEDDING_MODEL/RERANKER_MODEL comments
 * for the account/provider this shares). Injectable transport so
 * production calls the real API, the eval replays a committed fixture,
 * and tests use a deterministic fake — the same constructor-injection
 * pattern NativeStore's embedFn already uses.
 */

export interface RerankResultItem {
  index: number;
  relevanceScore: number;
}

export interface RerankInput {
  query: string;
  documents: string[];
  model?: string;
  timeoutMs?: number;
}

/** Test/eval seam — same shape the production transport returns. */
export type RerankFn = (input: RerankInput) => Promise<RerankResultItem[]>;

export type RerankFailureReason =
  | "auth"
  | "rate_limit"
  | "network"
  | "timeout"
  | "payload_too_large"
  | "unknown";

export class RerankError extends Error {
  reason: RerankFailureReason;
  status?: number;
  constructor(message: string, reason: RerankFailureReason, status?: number) {
    super(message);
    this.name = "RerankError";
    this.reason = reason;
    this.status = status;
  }
}

const ZEROENTROPY_RERANK_URL = "https://api.zeroentropy.dev/v1/models/rerank";
const DEFAULT_RERANK_TIMEOUT_MS = 5000;
// ZeroEntropy's own /v1/models/rerank payload cap.
const MAX_PAYLOAD_BYTES = 5_000_000;

/** Production transport — a real, paid ZeroEntropy zerank-2 call. Needs
 * ZEROENTROPY_API_KEY. Never call this from a test or eval loop. */
export async function zeroEntropyRerank(input: RerankInput): Promise<RerankResultItem[]> {
  const apiKey = process.env.ZEROENTROPY_API_KEY;
  if (!apiKey) {
    throw new RerankError("zeroEntropyRerank: ZEROENTROPY_API_KEY is not set", "auth");
  }

  const body = JSON.stringify({
    model: input.model ?? "zerank-2",
    query: input.query,
    documents: input.documents,
  });
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > MAX_PAYLOAD_BYTES) {
    throw new RerankError(
      `zeroEntropyRerank: payload ${bodyBytes} bytes exceeds ${MAX_PAYLOAD_BYTES} byte cap`,
      "payload_too_large",
    );
  }

  const ctrl = new AbortController();
  const timeoutMs = input.timeoutMs ?? DEFAULT_RERANK_TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(new Error("rerank timed out")), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(ZEROENTROPY_RERANK_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body,
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new RerankError("zeroEntropyRerank: timed out", "timeout");
    }
    throw new RerankError(
      `zeroEntropyRerank: ${err instanceof Error ? err.message : String(err)}`,
      "network",
    );
  }
  clearTimeout(timer);

  if (!resp.ok) {
    let msg = `zeroEntropyRerank: HTTP ${resp.status}`;
    try {
      const txt = await resp.text();
      if (txt) msg = `${msg}: ${txt.slice(0, 500)}`;
    } catch {
      // Body read failed — preserve the status-only message.
    }
    const reason: RerankFailureReason =
      resp.status === 401 || resp.status === 403
        ? "auth"
        : resp.status === 429
          ? "rate_limit"
          : resp.status >= 500
            ? "network"
            : "unknown";
    throw new RerankError(msg, reason, resp.status);
  }

  const json = (await resp.json()) as { results?: Array<{ index: number; relevance_score: number }> };
  if (!json || !Array.isArray(json.results)) {
    throw new RerankError("zeroEntropyRerank: malformed response (no results array)", "unknown");
  }
  return json.results.map((r) => ({ index: r.index, relevanceScore: r.relevance_score }));
}

export interface RerankerOpts {
  enabled: boolean;
  /** How many of the top candidates to send to the reranker. */
  topNIn: number;
  /** Truncate the reranked output to this many. null = no truncate. */
  topNOut: number | null;
  model?: string;
  timeoutMs?: number;
}

/**
 * Reorder the top `topNIn` candidates by cross-encoder relevance; the
 * un-reranked tail keeps its original fused-rank order, appended after
 * the reordered head. Fail-open: any transport error (auth, network,
 * timeout, a malformed response) logs nothing and returns `results`
 * unchanged — a flaky reranker must never break search.
 */
export async function applyReranker<
  T extends { chunkText: string; title: string; score: number; rerankScore?: number },
>(query: string, results: T[], opts: RerankerOpts, rerankFn: RerankFn): Promise<T[]> {
  if (!opts.enabled || results.length === 0 || opts.topNIn <= 0) return results;

  const head = results.slice(0, opts.topNIn);
  const tail = results.slice(opts.topNIn);
  const documents = head.map((r) => r.chunkText || r.title || "");

  let reranked: RerankResultItem[];
  try {
    reranked = await rerankFn({
      query,
      documents,
      timeoutMs: opts.timeoutMs,
      ...(opts.model ? { model: opts.model } : {}),
    });
  } catch {
    return results;
  }
  if (!Array.isArray(reranked) || reranked.length === 0) return results;

  const seen = new Set<number>();
  const reorderedHead: T[] = [];
  for (const r of reranked) {
    if (r.index >= 0 && r.index < head.length && !seen.has(r.index)) {
      seen.add(r.index);
      const item = head[r.index]!;
      item.rerankScore = r.relevanceScore;
      reorderedHead.push(item);
    }
  }
  // Reranker dropped some head items (only happens with an explicit top_n,
  // which this store never sends) — keep them at their original position
  // rather than silently losing recall.
  for (let i = 0; i < head.length; i++) {
    if (!seen.has(i)) reorderedHead.push(head[i]!);
  }

  const combined = [...reorderedHead, ...tail];
  return opts.topNOut !== null && opts.topNOut > 0 ? combined.slice(0, opts.topNOut) : combined;
}

/**
 * Production embedding transport — ZeroEntropy zembed-1, the same wire
 * contract the vendored engine's gateway used for EngineStore's default
 * embedFn (endpoint, auth, dims — see ../adapters/engine/store.ts's
 * EMBEDDING_MODEL/EMBEDDING_DIMENSIONS comment for the shared account/model
 * this reaches). Injectable EmbedFn shape NativeStore already takes:
 * production wires this in, tests/eval wire in a deterministic fake or a
 * replayed fixture instead — same convention as rerank.ts's
 * zeroEntropyRerank.
 *
 * input_type: always 'document'. The engine's own gateway threads
 * 'query' vs 'document' for asymmetric retrieval (embedQuery vs embed) but
 * NativeStore's EmbedFn is a single (text) => vector function with no
 * query/document signal to carry — search.ts's own query-time call already
 * goes through this same non-distinguishing shape (see its `embed(query)`
 * call site), and so does every fake/replay embedFn this store already
 * uses. Matching that shape exactly, rather than introducing a second
 * asymmetric-aware entry point, is what keeps the eval's recorded numbers
 * (measured against this same shape) meaningful.
 *
 * No retries: a single fetch attempt, same as rerank.ts's own transport.
 * The engine's embedQuery() never sets an explicit retry count either — it
 * inherits whatever the Vercel AI SDK defaults to internally — but that's
 * a library default this store has no equivalent dependency for, not a
 * deliberate retry policy worth reproducing. Unlike rerank (fail-open by
 * design — a flaky reranker must never break search), a failed embed here
 * throws to the caller: putPage embeds before writing anything, so a
 * thrown error here leaves no partial state, and a silently-skipped
 * embed would leave a page written but unsearchable with no signal that
 * happened.
 */

export type EmbedFailureReason =
  | "auth"
  | "rate_limit"
  | "network"
  | "timeout"
  | "dim_mismatch"
  | "unknown";

export class EmbedError extends Error {
  reason: EmbedFailureReason;
  status?: number;
  constructor(message: string, reason: EmbedFailureReason, status?: number) {
    super(message);
    this.name = "EmbedError";
    this.reason = reason;
    this.status = status;
  }
}

const ZEROENTROPY_EMBED_URL = "https://api.zeroentropy.dev/v1/models/embed";
const DEFAULT_EMBED_TIMEOUT_MS = 10_000;

// Matches native/store.ts's EMBEDDING_MODEL account/model and the
// content_chunks.embedding column width (vector(1280)) native/schema.ts
// creates. Hardcoded, not a config knob — see schema.ts's own comment for
// why changing it needs a coordinated migration, not a flag flip.
export const EMBEDDING_DIMENSIONS = 1280;

/** Production transport — a real, paid ZeroEntropy zembed-1 call. Needs
 * ZEROENTROPY_API_KEY. Never call this from a test or eval loop. */
export async function zeroEntropyEmbed(text: string): Promise<Float32Array> {
  const apiKey = process.env.ZEROENTROPY_API_KEY;
  if (!apiKey) {
    throw new EmbedError("zeroEntropyEmbed: ZEROENTROPY_API_KEY is not set", "auth");
  }

  const body = JSON.stringify({
    model: "zembed-1",
    input: [text],
    dimensions: EMBEDDING_DIMENSIONS,
    input_type: "document",
    encoding_format: "float",
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("embed timed out")), DEFAULT_EMBED_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(ZEROENTROPY_EMBED_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body,
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new EmbedError("zeroEntropyEmbed: timed out", "timeout");
    }
    throw new EmbedError(
      `zeroEntropyEmbed: ${err instanceof Error ? err.message : String(err)}`,
      "network",
    );
  }
  clearTimeout(timer);

  if (!resp.ok) {
    let msg = `zeroEntropyEmbed: HTTP ${resp.status}`;
    try {
      const txt = await resp.text();
      if (txt) msg = `${msg}: ${txt.slice(0, 500)}`;
    } catch {
      // Body read failed — preserve the status-only message.
    }
    const reason: EmbedFailureReason =
      resp.status === 401 || resp.status === 403
        ? "auth"
        : resp.status === 429
          ? "rate_limit"
          : resp.status >= 500
            ? "network"
            : "unknown";
    throw new EmbedError(msg, reason, resp.status);
  }

  const json = (await resp.json()) as { results?: Array<{ embedding: number[] }> };
  if (!json || !Array.isArray(json.results) || json.results.length !== 1) {
    throw new EmbedError(
      "zeroEntropyEmbed: malformed response (expected exactly one result)",
      "unknown",
    );
  }

  const embedding = json.results[0]?.embedding;
  // A silent wrong-width vector would still write and still cosine-compare
  // against every other row in pgvector — just wrong, with no error anyone
  // would notice until search quality quietly degraded. Reject loudly
  // instead.
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new EmbedError(
      `zeroEntropyEmbed: expected ${EMBEDDING_DIMENSIONS} dims, got ` +
        `${Array.isArray(embedding) ? embedding.length : "a non-array response"}`,
      "dim_mismatch",
    );
  }
  return Float32Array.from(embedding);
}

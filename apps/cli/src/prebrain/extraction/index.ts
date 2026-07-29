// Extraction: turns gate-passed source chunks into structured draft
// rules, in either of two modes. Both modes run
// entirely from this CLI process on the customer's device -- cloud mode
// calls Anthropic's Messages API directly (cloud.ts), local mode calls a
// local Ollama daemon directly (local.ts). Neither mode's model call
// routes through any gnt server: extractFromChunkCloud constructs its
// own `Anthropic` client from a key that came from the caller's own
// machine and calls Anthropic's API directly; extractFromChunkLocal
// fetches a `localhost` (or otherwise caller-specified) Ollama endpoint
// directly. That's the hard architecture constraint that "source text
// reaches a cloud model only from their device... nothing routes through
// gnt infrastructure" means in code: there
// is no fetch call anywhere in this module, or in cloud.ts/local.ts,
// that targets a gnt-owned host.
import { extractFromChunkCloud } from "./cloud.js";
import { DEFAULT_LOCAL_CONCURRENCY, extractFromChunkLocal } from "./local.js";
import type { ExtractedRuleCandidate, ExtractionResult } from "./schema.js";
import type { ExtractedRule, ExtractionOptions, PrebrainChunk, SourceCitation } from "./types.js";

export {
  MissingCloudApiKeyError,
  resolveCloudApiKey,
} from "./cloud.js";
export {
  DEFAULT_LOCAL_CONCURRENCY,
  DEFAULT_OLLAMA_HOST,
  DEFAULT_OLLAMA_MODEL,
  OllamaResponseError,
  OllamaUnavailableError,
} from "./local.js";
export {
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_PROMPT_VERSION,
  ExtractedRuleCandidateSchema,
  ExtractionResultSchema,
  buildExtractionSystemPrompt,
} from "./schema.js";
export { sanitize } from "./sanitize.js";
export { wrapChunkAsDataBlock } from "./wrap.js";
export type {
  ExtractedRuleCandidate,
  ExtractionResult,
} from "./schema.js";
export type {
  ExtractedRule,
  ExtractionMode,
  ExtractionOptions,
  PrebrainChunk,
  PrebrainProfile,
  SourceCitation,
} from "./types.js";

// Short, human-readable excerpt embedded in each rule's source citation
// -- long enough to give a reviewer (and the eventual draft-PR task, 2.4)
// useful context, short enough not to duplicate the whole chunk. The
// chunk's full text never gets stored anywhere by this module -- it's
// used to build one prompt and one excerpt, then discarded, per
// constraint 1 ("extract into proposals, never into a database").
const EXCERPT_MAX_CHARS = 240;

function excerptOf(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > EXCERPT_MAX_CHARS ? `${collapsed.slice(0, EXCERPT_MAX_CHARS - 1)}…` : collapsed;
}

// "README.md:42-58", or "README.md:42" for a single-line chunk -- a
// readable provenance string, built straight
// off the chunk's own local path/line-span fields so the draft-PR step
// downstream can pass it through to CreateRuleRequest.source unchanged.
function buildSourceString(chunk: PrebrainChunk): string {
  return chunk.startLine === chunk.endLine
    ? `${chunk.sourcePath}:${chunk.startLine}`
    : `${chunk.sourcePath}:${chunk.startLine}-${chunk.endLine}`;
}

function toExtractedRule(candidate: ExtractedRuleCandidate, chunk: PrebrainChunk): ExtractedRule {
  const citation: SourceCitation = {
    sourcePath: chunk.sourcePath,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    walker: chunk.walker,
    excerpt: excerptOf(chunk.text),
  };
  return {
    title: candidate.title,
    body: candidate.body,
    confidence: candidate.confidence,
    tags: candidate.tags,
    source: buildSourceString(chunk),
    sourceCitations: [citation],
  };
}

function extractFromChunk(chunk: PrebrainChunk, options: ExtractionOptions): Promise<ExtractionResult> {
  return options.mode === "cloud" ? extractFromChunkCloud(chunk, options) : extractFromChunkLocal(chunk, options);
}

// Thrown when at least one chunk failed to extract. Carries the rules
// that DID succeed (partialRules) alongside the per-chunk failure
// messages (chunkErrors), so a caller (the eventual `gnt prebrain`
// command) can choose to show the customer "extracted N rules, 2 chunks
// failed: ..." instead of losing an entire run's worth of good rules to
// one bad chunk.
export class ExtractionError extends Error {
  constructor(
    public readonly partialRules: ExtractedRule[],
    public readonly chunkErrors: string[],
  ) {
    super(`${chunkErrors.length} chunk(s) failed extraction:\n${chunkErrors.join("\n")}`);
    this.name = "ExtractionError";
  }
}

// Bounded worker-pool concurrency -- a fixed number of workers each pull
// the next chunk off a shared cursor until the list is empty, settling
// each one the same way Promise.allSettled would (a rejection never stops
// the pool, it's just recorded against that chunk's slot). No dependency
// needed for this: the chunk list is already fully known up front, not a
// paginated/streaming source, so a plain index cursor is the whole
// algorithm. `limit` is clamped to at least 1 and at most items.length so
// cloud mode (called with chunks.length) still runs every chunk in its own
// worker, i.e. fully concurrent, exactly like the old unbounded
// Promise.allSettled did.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item === undefined) continue; // unreachable: index is always < items.length here
      try {
        results[index] = { status: "fulfilled", value: await run(item) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/**
 * The single extraction entry point both modes implement behind one
 * interface -- callers branch on nothing themselves; `options.mode`
 * picks cloud vs. local once, here.
 *
 * Runs one model call per chunk, not chunks batched into fewer, larger
 * calls: this keeps "a chunk with no decision-prose extracts to
 * nothing" an exact per-chunk contract (see ExtractionResultSchema in
 * ./schema.ts) and keeps per-rule provenance trivial to attach, at the
 * cost of one call per chunk rather than fewer. Cloud mode's calls run
 * fully concurrently -- Anthropic's/the gateway's own capacity, not this
 * process, is the bottleneck there. Local mode is bounded to
 * DEFAULT_LOCAL_CONCURRENCY (overridable via options.localConcurrency): a
 * customer's own Ollama daemon is one model instance on their own
 * hardware, and firing every chunk at it at once just queues requests
 * behind each other while each one's own REQUEST_TIMEOUT_MS keeps
 * running underneath it -- see local.ts's own comment on this constant
 * for the actual failure mode that caused (a large run timing out chunks
 * that were never really being worked on, and the run proceeding on
 * whatever partial results survived with no clear signal of the size of
 * what got dropped).
 *
 * The per-org LLM spend quota (gnt.llm_quota, enforced server-side on
 * gnt's own call sites: check_action, propose_rule's conflict check)
 * does not apply here -- this call never reaches gnt's servers at all.
 * The customer's own Anthropic key, or their own local Ollama daemon,
 * pays this cost and latency directly, not gnt's bill.
 *
 * A chunk-level failure (a schema-violating local-model response, a
 * network error, a missing API key) is never swallowed into "no rules
 * found" for that chunk -- it's surfaced back to the caller via
 * ExtractionError, tagged with which chunk failed, so a real extraction
 * bug in one chunk can't silently look identical to "this chunk had no
 * rule in it."
 */
export async function extractRules(
  chunks: PrebrainChunk[],
  options: ExtractionOptions,
): Promise<ExtractedRule[]> {
  const concurrency = options.mode === "local" ? (options.localConcurrency ?? DEFAULT_LOCAL_CONCURRENCY) : chunks.length;
  const settled = await mapWithConcurrency(chunks, concurrency, (chunk) => extractFromChunk(chunk, options));

  const rules: ExtractedRule[] = [];
  const chunkErrors: string[] = [];

  settled.forEach((result, index) => {
    const chunk = chunks[index];
    if (!chunk) return; // unreachable: settled has exactly one entry per chunk
    if (result.status === "fulfilled") {
      for (const candidate of result.value.rules) {
        rules.push(toExtractedRule(candidate, chunk));
      }
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      chunkErrors.push(`${buildSourceString(chunk)}: ${reason}`);
    }
  });

  if (chunkErrors.length > 0) {
    throw new ExtractionError(rules, chunkErrors);
  }
  return rules;
}

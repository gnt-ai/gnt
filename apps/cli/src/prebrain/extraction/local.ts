import { buildExtractionSystemPrompt, EXTRACTION_JSON_SCHEMA, ExtractionResultSchema } from "./schema.js";
import type { ExtractionResult } from "./schema.js";
import type { ExtractionOptions, PrebrainChunk } from "./types.js";
import { wrapChunkAsDataBlock } from "./wrap.js";

// Ollama's own documented default host:port. Overridable via
// options.ollamaHost for anyone running the daemon elsewhere.
export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";

// Founder decision: Llama 3.1 8B Instruct via Ollama is
// the first local-only target. That model family ships a single 8B tag
// in Ollama's library, "llama3.1:8b" (which "llama3.1:latest" also
// currently resolves to) -- there's no separate "-instruct"-suffixed tag
// for this size the way some other model families expose base and
// instruct as distinct tags. This plain "8b" tag *is* the
// instruction-tuned model the founder decision names. Overridable via
// options.ollamaModel.
export const DEFAULT_OLLAMA_MODEL = "llama3.1:8b";

// Local inference on a customer's own hardware is slow, especially CPU-
// only -- much longer than the 10s timeout this CLI uses for gnt's own
// API calls elsewhere (see commands/gaps.ts). Long enough to cover a
// slow first-token/cold-model-load run without hanging the CLI forever
// on a daemon that's genuinely stuck.
const REQUEST_TIMEOUT_MS = 120_000;

// A local Ollama daemon is one model instance on the customer's own
// hardware, not a provider that autoscales -- unlike cloud mode (backed by
// Anthropic's/the gateway's own capacity), firing every chunk's request at
// Ollama at once just queues them behind each other while every request's
// own REQUEST_TIMEOUT_MS clock keeps running, so a large run times out
// requests that were never actually being worked on. Kept low and
// overridable (options.localConcurrency) rather than unbounded like cloud
// mode's fan-out -- see ./index.ts's extractRules for where this is
// actually applied.
export const DEFAULT_LOCAL_CONCURRENCY = 2;

// Measured, reproducible finding from this CLI's own extraction eval
// (apps/cli/eval/extraction/README.md, "The gap: not (only) model
// quality"): once EXTRACTION_JSON_SCHEMA's minLength/maxLength/minimum/
// maximum keywords (from ExtractedRuleCandidateSchema's .min()/.max()
// calls in schema.ts) are present anywhere in the schema passed as
// Ollama's `format` field, llama3.1:8b's grammar-constrained structured
// output stops respecting `format` at all and free-generates prose
// instead of JSON, on every call. These keywords generally can't be
// compiled into a generation grammar the way type/properties/required
// can, and this Ollama version fails closed on the whole schema rather
// than dropping just the unsupported keywords.
//
// Stripped only from the copy sent to Ollama below -- the zod
// ExtractionResultSchema still validates the parsed response against the
// real bounds a few lines down, so a response Ollama happens to return
// outside those bounds is still rejected, not silently accepted.
const OLLAMA_INCOMPATIBLE_SCHEMA_KEYWORDS = new Set(["minLength", "maxLength", "minimum", "maximum"]);

function stripOllamaIncompatibleKeywords(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripOllamaIncompatibleKeywords);
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (OLLAMA_INCOMPATIBLE_SCHEMA_KEYWORDS.has(key)) continue;
      out[key] = stripOllamaIncompatibleKeywords(value);
    }
    return out;
  }
  return node;
}

// Computed once at module load -- EXTRACTION_JSON_SCHEMA is a static
// derivation of ExtractionResultSchema, so there's no reason to redo this
// walk on every extraction call.
const OLLAMA_FORMAT_SCHEMA = stripOllamaIncompatibleKeywords(EXTRACTION_JSON_SCHEMA);

export class OllamaUnavailableError extends Error {
  constructor(host: string, cause?: unknown) {
    super(
      `Could not reach a local Ollama daemon at ${host} (connection failed or it ` +
        "didn't respond in time). Local-only extraction needs Ollama installed, " +
        `running, and the ${DEFAULT_OLLAMA_MODEL} model pulled:\n` +
        "  1. Install Ollama: https://ollama.com/download\n" +
        "  2. Make sure the daemon is running (it usually starts automatically after install)\n" +
        `  3. Pull the model: ollama pull ${DEFAULT_OLLAMA_MODEL}\n` +
        "Then re-run gnt prebrain in local-only mode.",
    );
    this.name = "OllamaUnavailableError";
    this.cause = cause;
  }
}

export class OllamaResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaResponseError";
  }
}

interface OllamaChatResponse {
  message?: { content?: string };
}

/**
 * Local-only extraction via a local Ollama daemon's HTTP API -- a plain
 * fetch against Ollama's own documented endpoint, no Ollama SDK
 * dependency, matching this CLI's existing low-dependency discipline
 * (see how the rest of apps/cli avoids adding clients for things a
 * direct fetch already covers cleanly).
 *
 * Uses POST /api/chat rather than /api/generate: the chat endpoint takes
 * a system/user message pair, the same shape cloud.ts's call uses, so
 * the delimited-data-block wrapping and versioned prompt are built
 * identically for both modes in ./schema.ts and ./wrap.ts. generate's
 * single flat prompt string would need that structure folded in by hand
 * with no equivalent request-level separation between instructions and
 * data.
 *
 * Documented quality tradeoff, called out here honestly rather than
 * oversold: Llama 3.1 8B is a much smaller model than
 * Claude, with materially weaker instruction-following and structured-
 * output reliability. Expect more chunks where it either misses a real
 * rule, fabricates a marginal one despite the "return nothing"
 * instruction, or returns JSON that fails the schema outright (handled
 * below as a real extraction error, not silently swallowed into "no
 * rules found"). Local-only mode exists for orgs that need air-gap
 * guarantees badly enough to accept this quality gap deliberately, not
 * as a drop-in equivalent to cloud mode.
 */
export async function extractFromChunkLocal(
  chunk: PrebrainChunk,
  options: ExtractionOptions,
): Promise<ExtractionResult> {
  const host = options.ollamaHost ?? DEFAULT_OLLAMA_HOST;
  const model = options.ollamaModel ?? DEFAULT_OLLAMA_MODEL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: "system", content: buildExtractionSystemPrompt(options.profile) },
          { role: "user", content: wrapChunkAsDataBlock(chunk) },
        ],
        format: OLLAMA_FORMAT_SCHEMA,
      }),
    });
  } catch (err) {
    // Connection refused (daemon not running), DNS failure, or the
    // AbortController firing on timeout all land here as a raw fetch
    // rejection -- never let that surface to the customer as a bare
    // stack trace; wrap it in a clear, actionable error instead.
    throw new OllamaUnavailableError(host, err);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new OllamaResponseError(
      `Ollama returned ${response.status} from ${host}/api/chat: ${body.slice(0, 500)}`,
    );
  }

  const payload = (await response.json()) as OllamaChatResponse;
  const content = payload.message?.content;
  if (!content) {
    throw new OllamaResponseError(`Ollama's response had no message content to parse (model: ${model}).`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new OllamaResponseError(
      "Ollama's response did not parse as JSON -- this is the documented local-mode " +
        `reliability gap, not a bug in this client. Raw content: ${content.slice(0, 500)}`,
    );
  }

  const parsed = ExtractionResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new OllamaResponseError(
      `Ollama's JSON response did not match the extraction schema (model: ${model}): ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

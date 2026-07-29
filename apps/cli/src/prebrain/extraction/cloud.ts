import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { buildExtractionSystemPrompt, EXTRACTION_PROMPT_VERSION, ExtractionResultSchema } from "./schema.js";
import type { ExtractionResult } from "./schema.js";
import type { ExtractionOptions, PrebrainChunk } from "./types.js";
import { wrapChunkAsDataBlock } from "./wrap.js";

// Cheapest current Claude model capable of structured extraction --
// mirrors the cost-conscious default apps/api/src/gnt/config.py already
// uses at its own LLM call sites (check_action_model and
// rule_merge_model both default to claude-haiku-4-5), since extraction
// runs once per source chunk and a typical org's prebrain run is dozens
// of chunks. Overridable via options.anthropicModel. Always the bare
// Anthropic model id -- resolveCloudCredential's gateway path prefixes it
// with "anthropic/" at the actual call site below, same convention as
// apps/api's gateway_model().
const DEFAULT_MODEL = "claude-haiku-4-5";
const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
// See apps/api/src/gnt/anthropic_client.py's _ZERO_DATA_RETENTION_BODY --
// same flag, same reasoning, just the TS-side spelling of it.
const GATEWAY_ZDR_PROVIDER_OPTIONS = { gateway: { zeroDataRetention: true } };
// Generous relative to a typical extraction (source chunks are capped
// around 1200 chars by the walkers' own chunker, so a real rule body
// rarely approaches ExtractedRuleCandidateSchema's 8000-char ceiling),
// but sized off that schema's actual worst case -- up to 5 rules per
// chunk, each with its own title/body/tags -- rather than a typical
// case, so a genuinely rule-dense chunk doesn't get silently truncated
// into unparseable JSON.
const MAX_TOKENS = 4096;

// BYO-key resolution for cloud mode: an explicit apiKey option always
// wins; otherwise this falls back to ANTHROPIC_API_KEY, the standard env
// var convention the @anthropic-ai/sdk client itself understands. This
// is the one function meant to be the extension point
// for a second, later key source (a gnt-issued key, minted and billed
// server-side) -- adding that becomes a
// change to this function alone, not to extractRules or either mode's
// call site.
export function resolveCloudApiKey(options: Pick<ExtractionOptions, "apiKey">): string | undefined {
  return options.apiKey ?? process.env.ANTHROPIC_API_KEY;
}

export interface CloudCredential {
  apiKey: string;
  baseURL?: string;
  usingGateway: boolean;
}

// Layers a Vercel AI Gateway key on top of resolveCloudApiKey's direct-
// Anthropic resolution: an explicit options.aiGatewayApiKey, then
// AI_GATEWAY_API_KEY, wins when set -- routes through the gateway with
// zero-data-retention (see extractFromChunkCloud). Same explicit-option-
// wins-over-env-var convention either path uses. Falls back to
// resolveCloudApiKey's direct Anthropic key for anyone who hasn't set up a
// gateway key yet.
export function resolveCloudCredential(
  options: Pick<ExtractionOptions, "apiKey" | "aiGatewayApiKey">,
): CloudCredential | undefined {
  const gatewayKey = options.aiGatewayApiKey ?? process.env.AI_GATEWAY_API_KEY;
  if (gatewayKey) return { apiKey: gatewayKey, baseURL: GATEWAY_BASE_URL, usingGateway: true };
  const anthropicKey = resolveCloudApiKey(options);
  return anthropicKey ? { apiKey: anthropicKey, usingGateway: false } : undefined;
}

export class MissingCloudApiKeyError extends Error {
  constructor() {
    super(
      "No API key found for cloud extraction. Pass one via the apiKey " +
        "(direct Anthropic) or aiGatewayApiKey (Vercel AI Gateway) option, " +
        "or set the ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY environment " +
        'variable, or run extraction with { mode: "local" } for air-gapped ' +
        "extraction via a local Ollama daemon instead.",
    );
    this.name = "MissingCloudApiKeyError";
  }
}

// Cloud extraction: calls Anthropic's Messages API directly from this
// CLI process, running on the customer's device -- see index.ts's
// module comment for why that "directly" is a hard architecture
// constraint, not an implementation detail.
// This function only ever receives the model name, a prompt built from
// already-gate-passed, already-sanitized chunk text, and an API key that
// came from the caller's own machine (an env var or an explicit option)
// -- there is no gnt-server hop anywhere in this call, and nothing here
// could add one without a caller passing a different `apiKey`.
export async function extractFromChunkCloud(
  chunk: PrebrainChunk,
  options: ExtractionOptions,
): Promise<ExtractionResult> {
  const credential = resolveCloudCredential(options);
  if (!credential) throw new MissingCloudApiKeyError();

  const client = new Anthropic({ apiKey: credential.apiKey, baseURL: credential.baseURL });
  const model = options.anthropicModel ?? DEFAULT_MODEL;
  // providerOptions isn't a typed field on the Anthropic SDK's request
  // params, only something Vercel AI Gateway reads out of the raw JSON
  // body (vercel.com/docs/ai-gateway/security-and-compliance/zdr) -- built
  // as a loosely-typed object and cast at the call site below rather than
  // fighting the SDK's own param type for one gateway-only field. Omitted
  // entirely (not just undefined) when not routing through the gateway, so
  // a direct Anthropic call's request body matches exactly what it sent
  // before this.
  const params: Record<string, unknown> = {
    model: credential.usingGateway ? `anthropic/${model}` : model,
    max_tokens: MAX_TOKENS,
    system: buildExtractionSystemPrompt(options.profile),
    messages: [{ role: "user", content: wrapChunkAsDataBlock(chunk) }],
    output_config: { format: zodOutputFormat(ExtractionResultSchema) },
    ...(credential.usingGateway && options.requireZdr !== false ? { providerOptions: GATEWAY_ZDR_PROVIDER_OPTIONS } : {}),
  };
  const response = await client.messages.parse(
    params as unknown as Parameters<typeof client.messages.parse>[0],
  );

  if (!response.parsed_output) {
    throw new Error(
      `Extraction prompt v${EXTRACTION_PROMPT_VERSION}: cloud model response did not parse against the extraction schema.`,
    );
  }
  return response.parsed_output;
}

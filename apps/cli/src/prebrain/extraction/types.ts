// Shared types for prebrain extraction. See ./index.ts
// for the entry point.

// The walker module and the company-profile pass
// both landed on main while this module was in flight -- import their real,
// merged types directly rather than the narrow local placeholders this
// module used while all three were being built in parallel.
import type { PrebrainChunk } from "../types.js";
export type { PrebrainChunk } from "../types.js";

// Loosely typed on purpose -- extraction treats this as optional
// enrichment context only: it must
// produce correct output with no profile at all, so nothing in this
// module hard-imports CompanyProfile or pins to its exact shape (which
// the profile task, not this one, owns). describeProfile in schema.ts
// reads the real field names (description, agentFunctions) via this loose
// type rather than a typed import, so a future profile field change can't
// break extraction's compile.
export type PrebrainProfile = Record<string, unknown>;

export type ExtractionMode = "cloud" | "local";

// Attached to every extracted rule so a reviewer (and the eventual
// draft-PR task, 2.4) can see exactly where it came from. Not the same
// shape as CreateRuleRequest's own `source_citations: list[dict]` field
// (that field doesn't constrain the dict shape at all) -- this is this
// module's own structured version of that provenance; see ExtractedRule
// below for how the two line up.
export interface SourceCitation {
  sourcePath: string;
  startLine: number;
  endLine: number;
  walker: PrebrainChunk["walker"];
  excerpt: string;
}

// What extractRules returns per accepted extraction -- shaped directly
// against apps/api/src/gnt/routers/rules.py's CreateRuleRequest so task
// 2.4 (draft PRs with provenance) can pass these straight through to
// POST /v1/rules without reshaping: title/body/confidence/tags are the
// same names and the same constraints (title 1-200 chars, body 1-8000
// chars, confidence 0.0-1.0) as that Pydantic model -- enforced by the
// zod schema in ./schema.ts, not just this type. `source` is the
// free-text provenance string that model's `source` field expects,
// built from sourcePath/startLine/endLine (e.g. "README.md:42-58").
// `sourceCitations` is camelCase to match this codebase's own style;
// task 2.4 does a one-line key rename to the wire format's
// `source_citations`, not a reshape, when it builds the POST body.
export interface ExtractedRule {
  title: string;
  body: string;
  confidence: number;
  tags: string[];
  source: string;
  sourceCitations: SourceCitation[];
}

export interface ExtractionOptions {
  mode: ExtractionMode;
  // BYO key for cloud mode: aiGatewayApiKey (Vercel AI Gateway, routed with
  // zero-data-retention) wins over apiKey (direct to Anthropic) when both
  // are set. An explicit value here always wins over its own env var
  // fallback (see resolveCloudCredential in cloud.ts) -- accepting the key
  // as a parameter, rather than this module doing its own single hardcoded
  // lookup, is the extension point a
  // later key source needs: adding one becomes a change to
  // resolveCloudCredential alone, not a rewrite of extractRules or either
  // mode's call site. Unused in local mode, which talks to a local Ollama
  // daemon and needs no key at all.
  apiKey?: string;
  aiGatewayApiKey?: string;
  profile?: PrebrainProfile;
  // Overrides for tests and advanced use; production callers can omit
  // all three and get the documented defaults (see cloud.ts/local.ts).
  anthropicModel?: string;
  ollamaHost?: string;
  ollamaModel?: string;
  // Caps how many chunks extractRules sends to a local Ollama daemon at
  // once (see local.ts's DEFAULT_LOCAL_CONCURRENCY for why local mode needs
  // this and cloud mode doesn't). Unused in cloud mode.
  localConcurrency?: number;
  // Defaults true whenever a gateway credential is used -- real customer
  // source text always gets Vercel AI Gateway's zero-data-retention
  // routing; that's a hard architecture requirement, not a default to
  // relax casually. The one
  // caller allowed to pass false is eval/extraction/run.ts's --no-zdr
  // flag: that script only ever sends the synthetic, repo-committed
  // corpus (never a real customer's text), and ZDR is a Pro/Enterprise-
  // only Vercel feature, so a Hobby-plan gateway key can't spend its free
  // credits against this path with ZDR forced on. No other caller in
  // this codebase sets this.
  requireZdr?: boolean;
}

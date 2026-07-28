import { PLACEHOLDER_RE } from "./spans.js";
import type { PrivacyGateMapping } from "./types.js";

// Reverses applyPrivacyGate's substitutions after a cloud round-trip: the
// cloud model only ever sees maskedText, so whatever it hands back --
// refined wording, a draft rule, anything derived from that text -- still
// carries the placeholder tokens verbatim. This swaps every one back for
// its real value from the local mapping before that response gets written
// anywhere, so the final artifact carries real specifics no cloud model
// ever saw. Pure string substitution against an in-memory map -- no
// network call, same local-first constraint as the rest of this module
// (see index.ts).
//
// Reuses PLACEHOLDER_RE from spans.ts rather than a second placeholder
// regex, so this can't drift out of sync with what the gate layers
// actually emit -- add a PlaceholderKind to types.ts and update
// PLACEHOLDER_RE once, and both masking and detokenizing pick it up.
//
// A placeholder-shaped token with no entry in `mapping` -- the model
// paraphrased and produced [PERSON_3] when this run's gate only ever
// minted up to [PERSON_2], or hallucinated a token that was never actually
// masked -- is left in the output as literal text rather than throwing.
// An unresolved placeholder surfacing in a draft rule is a visible,
// catchable bug: a human reviewer sees "[PERSON_3]" sitting in the output
// and knows something's off. Throwing instead would take down the entire
// pipeline over one token the gate never produced, after the cloud
// round-trip already succeeded -- a worse failure mode for a step this
// late in the flow.
export function detokenize(text: string, mapping: PrivacyGateMapping): string {
  return text.replace(PLACEHOLDER_RE, (token) => mapping.placeholderToValue.get(token) ?? token);
}

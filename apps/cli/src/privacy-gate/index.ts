import { runDeterministicLayer } from "./layer1-deterministic.js";
import { runNerLayer } from "./layer2-ner.js";
import { runAmountsLayer } from "./layer2b-amounts.js";
import { runContextualLayer } from "./layer3-contextual.js";
import { PlaceholderRegistry } from "./registry.js";
import type { DetectionHit, PrivacyGateResult } from "./types.js";

export type {
  DetectionHit,
  GateLayer,
  LayerResult,
  PlaceholderKind,
  PrivacyGateMapping,
  PrivacyGateResult,
} from "./types.js";
export { runContextualLayer } from "./layer3-contextual.js";
export { detokenize } from "./detokenize.js";
export { buildRedactionReport, writeRedactionReport } from "./redaction-report.js";

// The privacy gate: every ingestion path (gnt prebrain and friends)
// must run source text through this before any of
// it reaches a cloud model. Nothing calls this yet -- prebrain doesn't
// exist yet -- this module is the gate itself.
//
// Runs the layers below in order, each on the
// previous layer's output, sharing one PlaceholderRegistry so a value
// masked by an earlier layer (or seen twice by the same layer) always
// gets the same placeholder:
//   1. deterministic detectors with validators (keys, credit cards, SSNs,
//      emails, phones, IPs)
//   2. NER (person names, org names, addresses/places)
//   2b. policy-vs-personal classification for bare dollar amounts and
//      percentages layer 1 deliberately skips -- see layer2b-amounts.ts
//      for why this has to run after NER rather than as part of layer 1
//   3. local-model contextual judgment pass (currently a documented no-op
//      -- see layer3-contextual.ts; real implementation lands later)
//
// No network calls happen anywhere in this call graph. That's a deliberate
// architecture constraint -- local-first processing, nothing
// routes through gnt infrastructure -- not just an implementation detail --
// layer 3's stub returning a local no-op rather than calling out to
// anything is part of honoring that today, before a real local-model
// runtime exists to call instead.
//
// Idempotent: every layer treats existing placeholder tokens ([EMAIL_1]
// and friends) as already-claimed spans before detecting anything new, so
// running this twice on its own output -- or on text that already
// contains placeholders from a prior run -- doesn't re-mask them.
export async function applyPrivacyGate(text: string): Promise<PrivacyGateResult> {
  const registry = new PlaceholderRegistry();

  const layer1 = runDeterministicLayer(text, registry);
  const layer2 = runNerLayer(layer1.text, registry);
  const layer2b = runAmountsLayer(layer2.text, registry);
  const layer3 = await runContextualLayer(layer2b.text, registry.toMapping().placeholderToValue);

  const hits: DetectionHit[] = [...layer1.hits, ...layer2.hits, ...layer2b.hits, ...layer3.hits];

  return {
    maskedText: layer3.text,
    mapping: registry.toMapping(),
    hits,
  };
}

import type { LayerResult } from "./types.js";

// Layer 3: local-model judgment pass for contextual identifiers layers 1
// and 2 can't catch mechanically -- "the customer's account", "Jane's
// usual order", anything that only reads as an identifier in context
// rather than matching a pattern or a name lexicon.
//
// Picking the actual local model/runtime (Ollama-compatible or otherwise)
// is an explicit founder decision, not this task's to make. This layer is therefore a clean interface and
// integration point with a documented no-op implementation: it returns
// the input text unchanged and reports zero hits. Layers 1 and 2 still run
// and mask everything they find; this layer just doesn't add anything on
// top of them yet.
//
// TODO: replace this body with a real call into the local
// model runtime once that's built. The signature is meant to stay stable
// across that change -- `text` is whatever layers 1-2 already masked,
// `existingPlaceholders` is the placeholder -> real-value side of the
// mapping so the model prompt/context can be told which spans are already
// handled and shouldn't be re-flagged, and the return shape (LayerResult)
// is exactly what layer 1 and layer 2 already return, so index.ts doesn't
// need to change to wire the real implementation in.
export async function runContextualLayer(
  text: string,
  existingPlaceholders: ReadonlyMap<string, string>,
): Promise<LayerResult> {
  void existingPlaceholders; // unused until the real implementation lands
  return { text, hits: [] };
}

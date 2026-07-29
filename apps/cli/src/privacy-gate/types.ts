// Shared types for the privacy gate. See ./index.ts for the entry point
// and the layer pipeline this implements.

// One placeholder family per entity kind, numbered per distinct value
// within that kind ([EMAIL_1], [EMAIL_2], ...). Kept as a union rather than
// a bare string so a typo in a layer file (e.g. "EMIAL") is a compile error,
// not a silent mismatch with what the redaction report reads later.
export type PlaceholderKind =
  | "PERSON"
  | "EMAIL"
  | "KEY"
  | "CREDIT_CARD"
  | "SSN"
  | "PHONE"
  | "IP"
  | "ORG"
  | "ADDRESS"
  | "AMOUNT";

// Which layer found a given hit. Recorded per-hit so the redaction report
// can show "masked by layer 2 (NER)" without re-running
// detection. "amounts" is the policy-vs-personal classification pass (see
// layer2b-amounts.ts) -- it runs after "ner" and
// before "contextual", so it's named for its position in the pipeline
// rather than folded into either neighboring layer's name.
export type GateLayer = "deterministic" | "ner" | "amounts" | "contextual";

// A single detector hit, kept around after masking so a later pass (the
// redaction report) can render "what was masked, by which layer"
// without re-deriving it from the mapping alone.
export interface DetectionHit {
  placeholder: string; // e.g. "[EMAIL_1]"
  kind: PlaceholderKind;
  layer: GateLayer;
  value: string; // the real value that got replaced
  start: number; // offset into the text *as this layer saw it*, not the original input
  end: number; // exclusive
}

// Bidirectional lookup so the detokenization step can go real -> placeholder
// (to check "did we already mask this exact value") or placeholder -> real
// (to substitute real values back in after cloud refinement) without
// re-deriving one direction from the other every call.
export interface PrivacyGateMapping {
  valueToPlaceholder: Map<string, string>;
  placeholderToValue: Map<string, string>;
}

// A raw candidate match a detector or the NER layer found in text, before
// it's been resolved against overlaps with other matches and turned into a
// placeholder substitution.
export interface RawMatch {
  kind: PlaceholderKind;
  value: string;
  start: number;
  end: number; // exclusive
}

// What a single layer produces: the text after that layer's substitutions,
// plus the hits it recorded. Each layer's output text becomes the next
// layer's input.
export interface LayerResult {
  text: string;
  hits: DetectionHit[];
}

export interface PrivacyGateResult {
  maskedText: string;
  mapping: PrivacyGateMapping;
  hits: DetectionHit[];
}

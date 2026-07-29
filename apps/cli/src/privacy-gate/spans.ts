import type { PlaceholderRegistry } from "./registry.js";
import type { DetectionHit, GateLayer, RawMatch } from "./types.js";

interface Span {
  start: number;
  end: number; // exclusive
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

// Matches any placeholder this module could have emitted, e.g. "[EMAIL_1]"
// or "[CREDIT_CARD_12]". Used before every layer runs so a second pass
// over already-masked text (or text that already contains a placeholder
// literally, e.g. pasted from a prior redaction report) never re-detects
// or re-wraps a placeholder token -- see index.test.ts's idempotency case.
// Exported so detokenize.ts can substitute placeholders back to real
// values using this exact same pattern, rather than a second regex that
// could drift out of sync with what the layers above actually emit.
export const PLACEHOLDER_RE =
  /\[(?:PERSON|EMAIL|KEY|CREDIT_CARD|SSN|PHONE|IP|ORG|ADDRESS|AMOUNT)_\d+\]/g;

// Finds every existing placeholder token in `text` so callers can treat
// those spans as already-claimed before running their own detectors.
export function existingPlaceholderSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    if (match.index === undefined) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

// Resolves a list of candidate matches (which may overlap each other, or
// overlap spans a caller has already claimed) into a non-overlapping set,
// in the order given. Earlier matches in `candidates` win ties, which is
// why every layer's detector list is ordered most-specific-first (a
// vendor-prefixed API key claims its span before the generic high-entropy
// fallback gets a chance at the same text).
export function resolveOverlaps(candidates: RawMatch[], reserved: Span[]): RawMatch[] {
  const claimed: Span[] = [...reserved];
  const resolved: RawMatch[] = [];
  for (const candidate of candidates) {
    if (claimed.some((span) => overlaps(candidate, span))) continue;
    resolved.push(candidate);
    claimed.push({ start: candidate.start, end: candidate.end });
  }
  return resolved;
}

// Replaces every match with its placeholder (via `registry`, so repeated
// values collapse onto one placeholder) and returns both the rewritten
// text and the hit records for the redaction report. Matches must already
// be non-overlapping (run them through resolveOverlaps first) and are
// applied left-to-right regardless of input order, so callers don't have
// to pre-sort.
export function applyMatches(
  text: string,
  matches: RawMatch[],
  registry: PlaceholderRegistry,
  layer: GateLayer,
): { text: string; hits: DetectionHit[] } {
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  const hits: DetectionHit[] = [];
  let out = "";
  let cursor = 0;

  for (const match of sorted) {
    out += text.slice(cursor, match.start);
    const placeholder = registry.getOrCreate(match.kind, match.value);
    out += placeholder;
    hits.push({
      placeholder,
      kind: match.kind,
      layer,
      value: match.value,
      start: match.start,
      end: match.end,
    });
    cursor = match.end;
  }
  out += text.slice(cursor);

  return { text: out, hits };
}

// Shannon entropy in bits per character. Used by the layer-1 generic
// high-entropy fallback to tell a real secret ("7f9a8b3c1d2e4f5a...")
// apart from an ordinary long word or phrase, which has far less
// character diversity per byte.
export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// Luhn checksum, used to tell an actual card number from an arbitrary
// 13-19 digit run (an order ID, a phone number with no separators, a
// database primary key). ~90% of random digit strings fail this, which is
// most of why layer 1's credit-card detector isn't "just a regex."
export function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

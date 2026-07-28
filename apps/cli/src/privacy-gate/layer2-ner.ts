import nlp from "compromise";
import type { PlaceholderRegistry } from "./registry.js";
import { applyMatches, existingPlaceholderSpans, resolveOverlaps } from "./spans.js";
import type { LayerResult, PlaceholderKind, RawMatch } from "./types.js";

// Layer 2: NER for person names, org names, and addresses/places, run over
// whatever layer 1 already masked.
//
// Library choice: compromise (https://github.com/spencermountain/compromise).
// This monorepo had no NER library anywhere (checked pnpm-lock.yaml for
// compromise/wink-nlp/natural/node-nlp before adding this dependency).
// Picked compromise over wink-nlp because:
//   - .people(), .organizations(), and .places() are built into the base
//     package -- no separate model download/package (wink-nlp needs
//     wink-eng-lite-web-model alongside wink-nlp itself for comparable
//     coverage, roughly doubling the footprint for this use case).
//   - Zero runtime dependencies, pure JS, MIT licensed, ships its own
//     TypeScript types.
//   - Actively maintained: v14.x on npm, millions of weekly downloads,
//     the tagger this relies on (proper-noun / person / org / place
//     tagging) is core to the library, not a plugin that could lag behind.
//   - It's pattern/lexicon-based rather than a statistical model, which
//     matches "lightweight" better than pulling in a trained model file --
//     the tradeoff is recall on names outside its lexicon/patterns, which
//     is exactly why layer 3 exists as a backstop for what layers 1-2 miss.
//
// Known limitation worth calling out explicitly rather than discovering
// silently later: compromise's tagger splits a possessive full name --
// "Jane Smith's" -- into two separate person matches ("Jane" and
// "Smith's") instead of one. Both pieces still get masked (as [PERSON_1]
// and [PERSON_2]), so nothing leaks, but the result reads as two people
// instead of one possessive reference to one person. Fixing that would
// mean re-merging adjacent person tags in this module, which risks
// over-merging unrelated capitalized words sitting next to each other;
// left as-is for now since under-merging (two placeholders, still fully
// masked) is the safe failure direction.
//
// compromise doesn't expose reliable character offsets for tagged spans
// across versions, so instead of trusting an offset API this does a
// literal substring search for each matched name/org/place string against
// the layer-1 output text (skipping spans layer 1 or an earlier match in
// this same layer already claimed). That's a deliberate simplification --
// it means a name that also happens to be a substring of unrelated text
// could over-match -- but it's robust to compromise's internal
// representation changing, which offset-chasing would not be.

function findLiteralOccurrences(text: string, value: string, kind: PlaceholderKind): RawMatch[] {
  if (value.trim().length === 0) return [];
  const out: RawMatch[] = [];
  let searchFrom = 0;
  while (true) {
    const index = text.indexOf(value, searchFrom);
    if (index === -1) break;
    out.push({ kind, value, start: index, end: index + value.length });
    searchFrom = index + value.length;
  }
  return out;
}

// compromise's array output sometimes retains the sentence-final period on
// a place/org/person name that ends a sentence (e.g. "San Francisco."
// instead of "San Francisco"). Only strip a lone trailing period preceded
// by a lowercase letter -- that's a sentence boundary, not part of an
// abbreviation like "U.S." or "St." where the letter right before the
// period is uppercase, which this deliberately leaves alone.
function trimSentenceFinalPeriod(value: string): string {
  return /[a-z]\.$/.test(value) ? value.slice(0, -1) : value;
}

function extractNames(text: string, method: "people" | "organizations" | "places"): string[] {
  const doc = nlp(text) as unknown as {
    people: () => { out: (format: "array") => string[] };
    organizations: () => { out: (format: "array") => string[] };
    places: () => { out: (format: "array") => string[] };
  };
  const names: string[] = doc[method]().out("array").map(trimSentenceFinalPeriod);
  // De-dupe (a repeated name shouldn't produce redundant candidate scans)
  // and drop anything too short to be a meaningful match on its own,
  // which cuts down on single-letter/stray-punctuation noise compromise
  // occasionally emits.
  return [...new Set(names)].filter((name) => name.trim().length > 1);
}

export function runNerLayer(text: string, registry: PlaceholderRegistry): LayerResult {
  const reserved = existingPlaceholderSpans(text);

  // Order matters for the same reason it does in layer 1: person names are
  // claimed before org/place names, so "Jane Smith" at Acme Corp doesn't
  // get partially reclaimed if a place/org match happens to overlap it.
  const candidates: RawMatch[] = [
    ...extractNames(text, "people").flatMap((name) => findLiteralOccurrences(text, name, "PERSON")),
    ...extractNames(text, "organizations").flatMap((name) => findLiteralOccurrences(text, name, "ORG")),
    ...extractNames(text, "places").flatMap((name) => findLiteralOccurrences(text, name, "ADDRESS")),
  ];

  const resolved = resolveOverlaps(candidates, reserved);
  return applyMatches(text, resolved, registry, "ner");
}

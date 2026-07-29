import type { PlaceholderRegistry } from "./registry.js";
import { applyMatches, existingPlaceholderSpans, resolveOverlaps } from "./spans.js";
import type { LayerResult, RawMatch } from "./types.js";

// Layer 1 deliberately never touches bare dollar amounts
// or percentages -- see the "does not mask a plain dollar amount" and
// "does not mask a plain percentage" cases in deterministic.test.ts --
// because a huge fraction of them are policy thresholds ("orders over $50
// ship free", "discounts over 15% need sign-off") and masking those would
// make an extracted rule useless. But that same restraint means a real
// personal figure -- "Jane's invoice was $4,392.17", "the customer's
// balance is $50,000" -- sails through unmasked too, because structurally
// it looks identical to a policy threshold. This layer is the explicit
// classification step that tells the two apart.
//
// Named for its position rather than folded into layer 1 or layer 2: it
// has to run *after* layer 2 (NER), not before it and not as part of
// layer 1. The single strongest signal available here -- adjacency to an
// already-masked [PERSON_n]/[ORG_n] placeholder -- doesn't exist until
// NER has run. Running this before layer 2 would mean re-implementing
// name detection just to get the same adjacency signal NER already
// computed for free. So it's its own pass, between layers 2 and 3,
// consuming layer 2's output text and sharing the same registry every
// other layer shares.
//
// Still fully local and deterministic/heuristic -- no network calls, no
// model inference -- same "local-first processing" constraint documented
// in index.ts. A real judgment-based contextual read of ambiguous cases is
// layer 3's job, not this one's.
//
// -- The classification heuristic --
//
// For every bare dollar/percentage figure layer 1 skipped, look at the
// text immediately around it for a "this belongs to someone specific"
// signal:
//   1. An already-masked [PERSON_n] or [ORG_n] placeholder sitting near
//      the figure (before *or* after it -- "Jane's invoice was $4,392.17"
//      and "$4,392.17 was charged to Jane Smith" both count).
//   2. A possessive marker right before the figure: a name/noun ending in
//      "'s" ("the customer's balance", "Jane's invoice"), or a possessive
//      pronoun ("their", "his", "her").
// A figure with neither signal nearby is left alone -- that's the default,
// matching layer 1's existing bias toward not touching bare thresholds,
// and it's the more important direction to get right: over-masking breaks
// extracted rules; under-masking is the narrower, second-order risk here
// since a genuinely personal figure with zero nearby entity reference is
// rare in practice.
//
// -- Known false-positive failure mode (accepted, not fixed) --
//
// The adjacency window is a fixed character radius around the figure, not
// a real clause/dependency parse. That means a possessive or a name
// elsewhere in the *same sentence* -- even one that has nothing to do with
// the figure -- can trigger a mask:
//   - "The customer's order must be over $50 to qualify for free
//     shipping." reads exactly like a generic shipping policy (the
//     amount doesn't belong to one particular customer's specific
//     transaction), but "customer's" sits right before "$50" and gets
//     read as a possessive owner. Masked.
//   - "Jane mentioned that orders over $50 always ship free." is a policy
//     statement Jane happens to be the one saying, not Jane's own $50.
//     But her masked placeholder sits well within the adjacency window of
//     the figure. Masked.
// Both are deliberate over-masking, not bugs:
// under-masking a real personal figure (a leak) is worse than an
// unnecessary [AMOUNT_n] in a draft rule (a nuisance). Narrowing the
// window to dodge these would also start missing real "the customer's
// balance is $50,000"-shaped personal figures where the possessive sits a
// few words further back, which is the failure direction that actually
// matters. See amounts.test.ts for both cases as explicit, documented
// tests rather than silent gaps.

const DOLLAR_RE = /\$\s?\d[\d,]*(?:\.\d{1,2})?\b/g;
const PERCENT_RE = /\b\d+(?:\.\d+)?%/g;

function findCandidates(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const re of [DOLLAR_RE, PERCENT_RE]) {
    for (const match of text.matchAll(re)) {
      if (match.index === undefined) continue;
      out.push({ kind: "AMOUNT", value: match[0], start: match.index, end: match.index + match[0].length });
    }
  }
  return out;
}

// Radius (in characters) searched around a figure for a personal-ownership
// signal. Wide enough to reach across a short possessive clause
// ("the customer's outstanding balance is $50,000"), narrow enough to stay
// inside one sentence in every test case this module ships with. See the
// "known false-positive failure mode" writeup above for what this width
// trades off.
const ADJACENCY_WINDOW = 45;

// An already-masked person/org placeholder near the figure -- the
// strongest signal available, since layer 2 already did the work of
// resolving that span to a specific entity.
const ENTITY_PLACEHOLDER_RE = /\[(?:PERSON|ORG)_\d+\]/;

// Common contractions that end in "'s" but aren't possessive ("it's" =
// "it is", not "belonging to it"). Excluded so a conditional like "...if
// it's over $50..." doesn't get misread as a possessive reference tying
// the figure to someone.
const NON_POSSESSIVE_CONTRACTIONS = new Set([
  "it's",
  "that's",
  "here's",
  "there's",
  "what's",
  "who's",
  "let's",
  "he's",
  "she's",
]);

// Calendar/time-period nouns in possessive form ("this quarter's revenue",
// "last year's discount rate", "today's exchange rate"). Grammatically
// these ARE possessives, but unlike the adversarial "customer's"/named-
// speaker cases documented above (which stay accepted -- the "owner" there
// is at least a person-shaped noun), a time period can never be the
// specific individual a dollar figure or percentage belongs to. This is a
// real false-positive fix, not a narrowing of the accepted tradeoff: it
// only ever suppresses a match that could never have been personal data
// in the first place, so it never costs recall on an actual name/entity
// possessive nearby ("Jane's" still fires even with a time-noun
// possessive elsewhere in the same window -- see amounts.test.ts).
//
// Deliberately NOT included: bare "day's" -- it collides with the common
// surname "Day" ("Robert Day's severance was $120,000" would go
// unmasked). "today's"/"yesterday's"/"tomorrow's" don't have a comparable
// surname collision, so they stay.
const NON_PERSONAL_POSSESSIVE_NOUNS = new Set([
  "today's",
  "yesterday's",
  "tomorrow's",
  "week's",
  "month's",
  "quarter's",
  "year's",
]);

const POSSESSIVE_PRONOUN_RE = /\b(?:their|his|her)\b/i;
const POSSESSIVE_NOUN_RE = /\b[A-Za-z][\w-]*'s\b/g;

function hasPossessiveMarker(window: string): boolean {
  if (POSSESSIVE_PRONOUN_RE.test(window)) return true;
  for (const match of window.matchAll(POSSESSIVE_NOUN_RE)) {
    const lowered = match[0].toLowerCase();
    if (!NON_POSSESSIVE_CONTRACTIONS.has(lowered) && !NON_PERSONAL_POSSESSIVE_NOUNS.has(lowered)) return true;
  }
  return false;
}

// Only the "before" window is checked for a possessive marker -- "the
// customer's balance is $50,000" reads owner-then-figure, and checking
// "after" too (e.g. "$50 ship free. The customer's next order...") would
// let an unrelated possessive in a *following* clause bleed backward onto
// an unrelated figure. The entity-placeholder check still looks both ways
// since "$4,392.17 was charged to Jane Smith" is a real, common phrasing
// with the name after the number.
function isPersonalValue(text: string, candidate: RawMatch): boolean {
  const before = text.slice(Math.max(0, candidate.start - ADJACENCY_WINDOW), candidate.start);
  const after = text.slice(candidate.end, Math.min(text.length, candidate.end + ADJACENCY_WINDOW));

  if (ENTITY_PLACEHOLDER_RE.test(before) || ENTITY_PLACEHOLDER_RE.test(after)) return true;
  if (hasPossessiveMarker(before)) return true;
  return false;
}

export function runAmountsLayer(text: string, registry: PlaceholderRegistry): LayerResult {
  const reserved = existingPlaceholderSpans(text);
  const candidates = findCandidates(text).filter((candidate) => isPersonalValue(text, candidate));
  const resolved = resolveOverlaps(candidates, reserved);
  return applyMatches(text, resolved, registry, "amounts");
}

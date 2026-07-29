"""Layer 1 deliberately never touches bare dollar amounts or percentages
-- see the "does not mask a plain dollar amount" and "does not mask a
plain percentage" cases in
test_privacy_gate_deterministic.py -- because a huge fraction of them are
policy thresholds ("orders over $50 ship free", "discounts over 15% need
sign-off") and masking those would make an extracted rule useless. But
that same restraint means a real personal figure -- "Jane's invoice was
$4,392.17", "the customer's balance is $50,000" -- sails through unmasked
too, because structurally it looks identical to a policy threshold. This
layer is the explicit classification step that tells the two apart.

Python port of apps/cli/src/privacy-gate/layer2b-amounts.ts -- same
adjacency-window heuristic, same possessive-marker check, same accepted
false-positive failure mode. See that file for the fuller writeup this
docstring condenses; the two sections below ("the classification
heuristic" and "known false-positive failure mode") are carried over
near-verbatim since the reasoning is unchanged by the language port.

-- The classification heuristic --

For every bare dollar/percentage figure layer 1 skipped, look at the text
immediately around it for a "this belongs to someone specific" signal:
  1. An already-masked [PERSON_n] or [ORG_n] placeholder sitting near the
     figure (before *or* after it -- "Jane's invoice was $4,392.17" and
     "$4,392.17 was charged to Jane Smith" both count).
  2. A possessive marker right before the figure: a name/noun ending in
     "'s" ("the customer's balance", "Jane's invoice"), or a possessive
     pronoun ("their", "his", "her").
A figure with neither signal nearby is left alone -- the default, matching
layer 1's existing bias toward not touching bare thresholds, and the more
important direction to get right: over-masking breaks extracted rules,
while under-masking is the narrower, second-order risk here, since a
genuinely personal figure with zero nearby entity reference is rare in
practice.

-- Known false-positive failure mode (accepted, not fixed) --

The adjacency window is a fixed character radius around the figure, not a
real clause/dependency parse. That means a possessive or a name elsewhere
in the *same sentence* -- even one that has nothing to do with the figure
-- can trigger a mask:
  - "The customer's order must be over $50 to qualify for free shipping."
    reads exactly like a generic shipping policy (the amount doesn't
    belong to one particular customer's specific transaction), but
    "customer's" sits right before "$50" and gets read as a possessive
    owner. Masked.
  - "Jane mentioned that orders over $50 always ship free." is a policy
    statement Jane happens to be the one saying, not Jane's own $50. But
    her masked placeholder sits well within the adjacency window of the
    figure. Masked.
Both are deliberate over-masking, not bugs: under-masking a real personal
figure (a leak) is worse than an unnecessary [AMOUNT_n] in a draft rule (a
nuisance). See
test_privacy_gate_amounts.py's own "adversarial" cases, which assert this
gap exists rather than silently hiding it -- same discipline the CLI
suite's amounts.test.ts and its layer-3 no-op eval corpus both use for
their own documented gaps.

One related case is NOT accepted, and is fixed rather than documented as a
gap: a calendar/time-period noun in possessive form ("this quarter's
revenue target is $50,000", "today's exchange rate adds 3%") used to read
as a possessive-owner signal too, since "quarter's"/"today's" match the
same bare possessive-noun shape as "customer's". Unlike the accepted cases
above, a time period is never the specific person or org a figure
personally belongs to -- there's no ambiguity to preserve by leaving it
masked, so `_NON_PERSONAL_POSSESSIVE_NOUNS` below excludes that closed set
of words from `_has_possessive_marker` the same way
`_NON_POSSESSIVE_CONTRACTIONS` already excludes "it's"/"that's"/etc.
"""

from __future__ import annotations

import re

from .registry import PlaceholderRegistry
from .spans import apply_matches, existing_placeholder_spans, resolve_overlaps
from .types import LayerResult, RawMatch

_DOLLAR_RE = re.compile(r"\$\s?\d[\d,]*(?:\.\d{1,2})?\b")
_PERCENT_RE = re.compile(r"\b\d+(?:\.\d+)?%")


def _find_candidates(text: str) -> list[RawMatch]:
    out: list[RawMatch] = []
    for pattern in (_DOLLAR_RE, _PERCENT_RE):
        for match in pattern.finditer(text):
            out.append(RawMatch(kind="AMOUNT", value=match.group(0), start=match.start(), end=match.end()))
    return out


# Radius (in characters) searched around a figure for a personal-ownership
# signal. Wide enough to reach across a short possessive clause ("the
# customer's outstanding balance is $50,000"), narrow enough to stay inside
# one sentence in every test case this module ships with.
_ADJACENCY_WINDOW = 45

# An already-masked person/org placeholder near the figure -- the
# strongest signal available, since layer 2 already did the work of
# resolving that span to a specific entity.
_ENTITY_PLACEHOLDER_RE = re.compile(r"\[(?:PERSON|ORG)_\d+\]")

# Common contractions that end in "'s" but aren't possessive ("it's" = "it
# is", not "belonging to it"). Excluded so a conditional like "...if it's
# over $50..." doesn't get misread as a possessive reference tying the
# figure to someone.
_NON_POSSESSIVE_CONTRACTIONS = {
    "it's",
    "that's",
    "here's",
    "there's",
    "what's",
    "who's",
    "let's",
    "he's",
    "she's",
}

# Calendar/time-period nouns in possessive form ("this quarter's revenue",
# "last year's discount rate", "today's exchange rate"). Grammatically
# these ARE possessives, but unlike the adversarial "customer's"/named-
# speaker cases documented above (which stay accepted -- the "owner" there
# is at least a person-shaped noun), a time period can never be the
# specific individual a dollar figure or percentage belongs to. This is a
# real false-positive fix, not a narrowing of the accepted tradeoff: it
# only ever suppresses a match that could never have been personal data in
# the first place, so it never costs recall on an actual name/entity
# possessive nearby (see test_still_masks_a_personal_amount_next_to_an_
# unrelated_time_possessive in test_privacy_gate_amounts.py -- "Jane's"
# still fires even with a time-noun possessive elsewhere in the same
# window).
#
# Deliberately NOT included: bare "day's" -- it collides with the common
# surname "Day" ("Robert Day's severance was $120,000" would go unmasked).
# "today's"/"yesterday's"/"tomorrow's" don't have a comparable surname
# collision, so they stay. See test_masks_the_surname_day_as_a_real_
# possessive_owner in test_privacy_gate_amounts.py.
_NON_PERSONAL_POSSESSIVE_NOUNS = {
    "today's",
    "yesterday's",
    "tomorrow's",
    "week's",
    "month's",
    "quarter's",
    "year's",
}

_POSSESSIVE_PRONOUN_RE = re.compile(r"\b(?:their|his|her)\b", re.IGNORECASE)
_POSSESSIVE_NOUN_RE = re.compile(r"\b[A-Za-z][\w-]*'s\b")


def _has_possessive_marker(window: str) -> bool:
    if _POSSESSIVE_PRONOUN_RE.search(window):
        return True
    for match in _POSSESSIVE_NOUN_RE.finditer(window):
        lowered = match.group(0).lower()
        if lowered in _NON_POSSESSIVE_CONTRACTIONS or lowered in _NON_PERSONAL_POSSESSIVE_NOUNS:
            continue
        return True
    return False


def _is_personal_value(text: str, candidate: RawMatch) -> bool:
    """Only the "before" window is checked for a possessive marker -- "the
    customer's balance is $50,000" reads owner-then-figure, and checking
    "after" too would let an unrelated possessive in a *following* clause
    bleed backward onto an unrelated figure. The entity-placeholder check
    still looks both ways since "$4,392.17 was charged to Jane Smith" is a
    real, common phrasing with the name after the number."""
    before = text[max(0, candidate.start - _ADJACENCY_WINDOW) : candidate.start]
    after = text[candidate.end : min(len(text), candidate.end + _ADJACENCY_WINDOW)]

    if _ENTITY_PLACEHOLDER_RE.search(before) or _ENTITY_PLACEHOLDER_RE.search(after):
        return True
    return _has_possessive_marker(before)


def run_amounts_layer(text: str, registry: PlaceholderRegistry) -> LayerResult:
    reserved = existing_placeholder_spans(text)
    candidates = [candidate for candidate in _find_candidates(text) if _is_personal_value(text, candidate)]
    resolved = resolve_overlaps(candidates, reserved)
    return apply_matches(text, resolved, registry, "amounts")

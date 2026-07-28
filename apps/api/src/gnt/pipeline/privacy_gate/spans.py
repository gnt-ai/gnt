"""Python port of apps/cli/src/privacy-gate/spans.ts -- overlap resolution,
placeholder-token detection, and the two shared math primitives (Shannon
entropy, Luhn) every layer builds on. Same reasoning as that file; see its
own comments for the fuller writeup.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

from .registry import PlaceholderRegistry
from .types import DetectionHit, GateLayer, LayerResult, RawMatch


@dataclass(frozen=True)
class Span:
    start: int
    end: int  # exclusive


def _overlaps(a: Span, b: Span) -> bool:
    return a.start < b.end and b.start < a.end


# Matches any placeholder this package could have emitted, e.g. "[EMAIL_1]"
# or "[CREDIT_CARD_12]". Run before every layer so a second pass over
# already-masked text (or text that already contains a placeholder
# literally) never re-detects or re-wraps a placeholder token -- see the
# idempotency tests in test_privacy_gate_index.py. Same pattern the CLI's
# detokenize.ts would use for the reverse direction, if this gate had a
# detokenize step (it deliberately doesn't -- see __init__.py).
PLACEHOLDER_RE = re.compile(
    r"\[(?:PERSON|EMAIL|KEY|CREDIT_CARD|SSN|PHONE|IP|ORG|ADDRESS|AMOUNT)_\d+\]"
)


def existing_placeholder_spans(text: str) -> list[Span]:
    """Finds every existing placeholder token in `text` so callers can
    treat those spans as already-claimed before running their own
    detectors."""
    return [Span(match.start(), match.end()) for match in PLACEHOLDER_RE.finditer(text)]


def resolve_overlaps(candidates: list[RawMatch], reserved: list[Span]) -> list[RawMatch]:
    """Resolves a list of candidate matches (which may overlap each other,
    or overlap spans a caller has already claimed) into a non-overlapping
    set, in the order given. Earlier matches in `candidates` win ties,
    which is why every layer's detector list is ordered
    most-specific-first (a vendor-prefixed API key claims its span before
    the generic high-entropy fallback gets a look)."""
    claimed: list[Span] = list(reserved)
    resolved: list[RawMatch] = []
    for candidate in candidates:
        candidate_span = Span(candidate.start, candidate.end)
        if any(_overlaps(candidate_span, span) for span in claimed):
            continue
        resolved.append(candidate)
        claimed.append(candidate_span)
    return resolved


def apply_matches(
    text: str, matches: list[RawMatch], registry: PlaceholderRegistry, layer: GateLayer
) -> LayerResult:
    """Replaces every match with its placeholder (via `registry`, so
    repeated values collapse onto one placeholder) and returns both the
    rewritten text and the hit records. Matches must already be
    non-overlapping (run them through resolve_overlaps first) and are
    applied left-to-right regardless of input order, so callers don't have
    to pre-sort."""
    sorted_matches = sorted(matches, key=lambda match: match.start)
    hits: list[DetectionHit] = []
    out: list[str] = []
    cursor = 0

    for match in sorted_matches:
        out.append(text[cursor : match.start])
        placeholder = registry.get_or_create(match.kind, match.value)
        out.append(placeholder)
        hits.append(
            DetectionHit(
                placeholder=placeholder,
                kind=match.kind,
                layer=layer,
                value=match.value,
                start=match.start,
                end=match.end,
            )
        )
        cursor = match.end
    out.append(text[cursor:])

    return LayerResult(text="".join(out), hits=hits)


def shannon_entropy(value: str) -> float:
    """Shannon entropy in bits per character. Used by the layer-1 generic
    high-entropy fallback to tell a real secret apart from an ordinary
    long word or phrase, which has far less character diversity per
    byte."""
    counts: dict[str, int] = {}
    for char in value:
        counts[char] = counts.get(char, 0) + 1
    entropy = 0.0
    length = len(value)
    for count in counts.values():
        p = count / length
        entropy -= p * math.log2(p)
    return entropy


def passes_luhn(digits: str) -> bool:
    """Luhn checksum, used to tell an actual card number from an arbitrary
    13-19 digit run (an order ID, a phone number with no separators, a
    database primary key). ~90% of random digit strings fail this, which is
    most of why layer 1's credit-card detector isn't "just a regex.\""""
    total = 0
    double = False
    for ch in reversed(digits):
        digit = int(ch)
        if double:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
        double = not double
    return total % 10 == 0

"""Layer 1: deterministic detectors with validators, not bare regexes.
Python port of apps/cli/src/privacy-gate/layer1-deterministic.ts -- same
detectors, same validation logic (Luhn, SSA invalid-range exclusions,
Shannon-entropy threshold), same false-positive-avoidance reasoning. See
that file for the fuller per-detector writeups this docstring condenses.

Each detector below returns *candidate* matches over the full input text --
overlap resolution against every other detector's candidates (and any
placeholder spans a prior gate run already left behind) happens once, in
run_deterministic_layer, in the priority order DETECTORS is declared in.
That order matters: a vendor-prefixed key claims its span before the
generic entropy fallback gets a look, a matched IP claims its dotted span
before the phone detector could mistake it for one, and so on.
"""

from __future__ import annotations

import re

from .registry import PlaceholderRegistry
from .spans import apply_matches, existing_placeholder_spans, passes_luhn, resolve_overlaps, shannon_entropy
from .types import LayerResult, PlaceholderKind, RawMatch


def _matches_of(pattern: re.Pattern[str], text: str, kind: PlaceholderKind) -> list[RawMatch]:
    return [
        RawMatch(kind=kind, value=match.group(0), start=match.start(), end=match.end())
        for match in pattern.finditer(text)
    ]


# Common vendor-prefixed API keys and tokens. Prefixes are enough on their
# own -- a "sk-" or "ghp_" followed by a long token is essentially never
# anything else in real prose, so there's no separate validator beyond
# "looks like the vendor's documented token shape."
_KEY_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b"),  # OpenAI/Anthropic/Stripe-style secret keys
    re.compile(r"\bghp_[A-Za-z0-9]{36}\b"),  # GitHub personal access token (classic)
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{22,}\b"),  # GitHub fine-grained PAT
    re.compile(r"\bxox[bp]-[A-Za-z0-9-]{10,}\b"),  # Slack bot/user token
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),  # AWS access key ID
    re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),  # Google API key
)


def _detect_keys(text: str) -> list[RawMatch]:
    return [match for pattern in _KEY_PATTERNS for match in _matches_of(pattern, text, "KEY")]


# Generic high-entropy long-token fallback, for secrets that don't carry
# one of the known vendor prefixes above. Requires the candidate to mix
# letters and digits (real tokens do; ordinary long English words almost
# never do) on top of a minimum Shannon entropy, so this doesn't fire on
# things like a long hyphenated product slug or a run-on sentence with no
# spaces in a log line.
_ENTROPY_CANDIDATE_RE = re.compile(r"[A-Za-z0-9_-]{20,}")
_ENTROPY_MIN_BITS_PER_CHAR = 3.0
_HAS_LETTER_RE = re.compile(r"[A-Za-z]")
_HAS_DIGIT_RE = re.compile(r"[0-9]")


def _detect_high_entropy_tokens(text: str) -> list[RawMatch]:
    out: list[RawMatch] = []
    for match in _ENTROPY_CANDIDATE_RE.finditer(text):
        value = match.group(0)
        if not _HAS_LETTER_RE.search(value) or not _HAS_DIGIT_RE.search(value):
            continue
        if shannon_entropy(value) < _ENTROPY_MIN_BITS_PER_CHAR:
            continue
        out.append(RawMatch(kind="KEY", value=value, start=match.start(), end=match.end()))
    return out


# Credit cards: Luhn-validated, not a bare 16-digit regex. Candidates are
# digit runs of plausible card length (13-19, per ISO/IEC 7812) allowing
# space or dash grouping, e.g. "4242 4242 4242 4242" or
# "4242-4242-4242-4242" as well as unbroken digits.
_CARD_CANDIDATE_RE = re.compile(r"\b\d(?:[\d -]{11,25}\d)\b")


def _detect_credit_cards(text: str) -> list[RawMatch]:
    out: list[RawMatch] = []
    for match in _CARD_CANDIDATE_RE.finditer(text):
        raw = match.group(0)
        digits = re.sub(r"[ -]", "", raw)
        if len(digits) < 13 or len(digits) > 19:
            continue
        if not passes_luhn(digits):
            continue
        out.append(RawMatch(kind="CREDIT_CARD", value=raw, start=match.start(), end=match.end()))
    return out


# SSNs: standard XXX-XX-XXXX format with the SSA's documented invalid
# ranges excluded -- area 000, area 666, area 900-999 (reserved for ITINs
# and never issued as SSNs), group 00, and serial 0000. Without these
# exclusions this would flag plenty of non-SSN dash-grouped numbers.
_SSN_RE = re.compile(r"\b(\d{3})-(\d{2})-(\d{4})\b")


def _detect_ssns(text: str) -> list[RawMatch]:
    out: list[RawMatch] = []
    for match in _SSN_RE.finditer(text):
        area, group, serial = match.group(1), match.group(2), match.group(3)
        if area in ("000", "666") or int(area) >= 900:
            continue
        if group == "00":
            continue
        if serial == "0000":
            continue
        out.append(RawMatch(kind="SSN", value=match.group(0), start=match.start(), end=match.end()))
    return out


# Solid-enough email match without a full RFC 5322 parser -- covers the
# normal local-part character set (letters, digits, and the common
# . _ % + - punctuation) and requires a real-looking domain with a 2+
# letter TLD, which is enough to avoid obvious false negatives on ordinary
# addresses while not trying to validate the entire grammar.
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def _detect_emails(text: str) -> list[RawMatch]:
    return _matches_of(_EMAIL_RE, text, "EMAIL")


# IPv4: standard dotted-quad with each octet range-checked (0-255), not a
# bare \d{1,3}(\.\d{1,3}){3} that would also match "999.999.999.999".
_IPV4_RE = re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b")

# IPv6: covers full-length, "::"-compressed, and the loopback/unspecified
# shorthand forms. Doesn't attempt every embedded-IPv4-in-IPv6 edge case
# (e.g. "::ffff:192.0.2.1"), an accepted gap -- those addresses still get
# caught by the IPv4 pattern above for their embedded portion.
#
# Uses lookbehind/lookahead rather than \b to bound each alternative: \b
# only fires on a word/non-word transition, and every character on either
# side of a bare "::" (a colon and, usually, whitespace) is non-word, so \b
# silently fails to anchor there. Python's re requires fixed-width
# lookbehind, same as this pattern needs (a single non-[:.\w] character),
# so the port is direct.
_IPV6_HEX = "[A-Fa-f0-9]{1,4}"
_IPV6_CORE = (
    f"(?:{_IPV6_HEX}:){{7}}{_IPV6_HEX}"  # full form, all 8 groups present
    f"|(?:{_IPV6_HEX}:){{1,7}}:(?:{_IPV6_HEX}:){{0,6}}{_IPV6_HEX}"  # "::" compressed, with a group after it
    f"|(?:{_IPV6_HEX}:){{1,7}}:"  # "::" compressed, nothing after it
    f"|::(?:{_IPV6_HEX}:){{0,6}}{_IPV6_HEX}"  # starts with "::"
    f"|::"  # bare "::" (unspecified address shorthand)
)
_IPV6_RE = re.compile(rf"(?<![:.\w])(?:{_IPV6_CORE})(?![:.\w])")


def _detect_ips(text: str) -> list[RawMatch]:
    # Private/loopback/link-local addresses get masked too, same as the
    # CLI's own choice: they aren't personal data, but this is still
    # sensitive infra detail, and this endpoint's gate stands in for the
    # customer's own device the way the CLI gate's runs on it -- the cost
    # of over-masking an internal address is a placeholder, not a support
    # ticket, while under-masking it is a real disclosure.
    return [*_matches_of(_IPV4_RE, text, "IP"), *_matches_of(_IPV6_RE, text, "IP")]


# US-shaped 3-3-4 numbers (with optional country code and/or parens around
# the area code) plus leading-"+" international numbers. Deliberately
# requires a separator between groups rather than matching bare unbroken
# digit runs -- an unbroken 10-digit string in prose is at least as likely
# to be an order ID or a database key as a phone number.
_PHONE_US_RE = re.compile(r"(?:\+\d{1,3}[-.\s]?)?(?:\(\d{3}\)[-.\s]?|\d{3}[-.\s])\d{3}[-.\s]?\d{4}\b")
_PHONE_INTL_RE = re.compile(r"\+\d{1,3}(?:[-.\s]?\d{1,4}){2,5}\b")
_NON_DIGIT_RE = re.compile(r"\D")


def _detect_phones(text: str) -> list[RawMatch]:
    candidates = [*_matches_of(_PHONE_US_RE, text, "PHONE"), *_matches_of(_PHONE_INTL_RE, text, "PHONE")]
    out = []
    for match in candidates:
        digit_count = len(_NON_DIGIT_RE.sub("", match.value))
        if 7 <= digit_count <= 15:
            out.append(match)
    return out


# Priority order: most specific/validated first, generic entropy fallback
# last. See resolve_overlaps in spans.py -- earlier entries here claim
# their span before later ones get a chance at overlapping text.
_DETECTORS = (
    _detect_keys,
    _detect_credit_cards,
    _detect_ssns,
    _detect_emails,
    _detect_ips,
    _detect_phones,
    _detect_high_entropy_tokens,
)


def run_deterministic_layer(text: str, registry: PlaceholderRegistry) -> LayerResult:
    reserved = existing_placeholder_spans(text)
    candidates = [match for detector in _DETECTORS for match in detector(text)]
    resolved = resolve_overlaps(candidates, reserved)
    return apply_matches(text, resolved, registry, "deterministic")

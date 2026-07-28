import type { PlaceholderRegistry } from "./registry.js";
import {
  applyMatches,
  existingPlaceholderSpans,
  passesLuhn,
  resolveOverlaps,
  shannonEntropy,
} from "./spans.js";
import type { LayerResult, PlaceholderKind, RawMatch } from "./types.js";

// Layer 1: deterministic detectors with validators, not bare regexes. Each
// detector below returns *candidate* matches over the full input text --
// overlap resolution against every other detector's candidates (and any
// placeholder spans a prior gate run already left behind) happens once, in
// runDeterministicLayer, in the priority order DETECTORS is declared in.
// That order matters: a vendor-prefixed key claims its span before the
// generic entropy fallback gets a look, a matched IP claims its dotted
// span before the phone detector could mistake it for one, and so on.

function matchesOf(re: RegExp, text: string, kind: PlaceholderKind): RawMatch[] {
  const out: RawMatch[] = [];
  for (const match of text.matchAll(re)) {
    if (match.index === undefined) continue;
    out.push({ kind, value: match[0], start: match.index, end: match.index + match[0].length });
  }
  return out;
}

// Common vendor-prefixed API keys and tokens. Prefixes are enough on their
// own here -- a "sk-" or "ghp_" followed by a long token is essentially
// never anything else in real prose, so there's no separate validator
// beyond "looks like the vendor's documented token shape."
const KEY_PATTERNS: RegExp[] = [
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g, // OpenAI/Anthropic/Stripe-style secret keys
  /\bghp_[A-Za-z0-9]{36}\b/g, // GitHub personal access token (classic)
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, // GitHub fine-grained PAT
  /\bxox[bp]-[A-Za-z0-9-]{10,}\b/g, // Slack bot/user token
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ID
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
];

function detectKeys(text: string): RawMatch[] {
  return KEY_PATTERNS.flatMap((re) => matchesOf(re, text, "KEY"));
}

// Generic high-entropy long-token fallback, for secrets that don't carry
// one of the known vendor prefixes above. Requires the candidate to mix
// letters and digits (real tokens do; ordinary long English words almost
// never do) on top of a minimum Shannon entropy, so this doesn't fire on
// things like a long hyphenated product slug or a run-on sentence with no
// spaces in a log line.
const ENTROPY_CANDIDATE_RE = /[A-Za-z0-9_-]{20,}/g;
const ENTROPY_MIN_BITS_PER_CHAR = 3.0;

function detectHighEntropyTokens(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const match of text.matchAll(ENTROPY_CANDIDATE_RE)) {
    if (match.index === undefined) continue;
    const value = match[0];
    const hasLetter = /[A-Za-z]/.test(value);
    const hasDigit = /[0-9]/.test(value);
    if (!hasLetter || !hasDigit) continue;
    if (shannonEntropy(value) < ENTROPY_MIN_BITS_PER_CHAR) continue;
    out.push({ kind: "KEY", value, start: match.index, end: match.index + value.length });
  }
  return out;
}

// Credit cards: Luhn-validated, not a bare 16-digit regex. Candidates are
// digit runs of plausible card length (13-19, per ISO/IEC 7812) allowing
// space or dash grouping, e.g. "4242 4242 4242 4242" or
// "4242-4242-4242-4242" as well as unbroken digits.
const CARD_CANDIDATE_RE = /\b\d(?:[\d -]{11,25}\d)\b/g;

function detectCreditCards(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const match of text.matchAll(CARD_CANDIDATE_RE)) {
    if (match.index === undefined) continue;
    const raw = match[0];
    const digits = raw.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (!passesLuhn(digits)) continue;
    out.push({ kind: "CREDIT_CARD", value: raw, start: match.index, end: match.index + raw.length });
  }
  return out;
}

// SSNs: standard XXX-XX-XXXX format with the SSA's documented invalid
// ranges excluded -- area 000, area 666, area 900-999 (reserved for ITINs
// and never issued as SSNs), group 00, and serial 0000. Without these
// exclusions this would flag plenty of non-SSN dash-grouped numbers.
const SSN_RE = /\b(\d{3})-(\d{2})-(\d{4})\b/g;

function detectSsns(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const match of text.matchAll(SSN_RE)) {
    if (match.index === undefined) continue;
    const [full, area, group, serial] = match;
    if (area === "000" || area === "666" || Number(area) >= 900) continue;
    if (group === "00") continue;
    if (serial === "0000") continue;
    out.push({ kind: "SSN", value: full, start: match.index, end: match.index + full.length });
  }
  return out;
}

// Solid-enough email match without a full RFC 5322 parser -- covers the
// normal local-part character set (letters, digits, and the common
// . _ % + - punctuation) and requires a real-looking domain with a
// 2+ letter TLD, which is enough to avoid obvious false negatives on
// ordinary addresses while not trying to validate the entire grammar.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function detectEmails(text: string): RawMatch[] {
  return matchesOf(EMAIL_RE, text, "EMAIL");
}

// IPv4: standard dotted-quad with each octet range-checked (0-255), not a
// bare \d{1,3}(\.\d{1,3}){3} that would also match "999.999.999.999".
const IPV4_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;

// IPv6: covers full-length, "::"-compressed, and the loopback/unspecified
// shorthand forms. Doesn't attempt every embedded-IPv4-in-IPv6 edge case
// (e.g. "::ffff:192.0.2.1"), which is an acceptable gap for "reasonable
// coverage" per the task -- those addresses still get caught by the IPv4
// pattern above for their embedded portion.
//
// Uses lookbehind/lookahead rather than \b to bound each alternative: \b
// only fires on a word/non-word transition, and every character on either
// side of a bare "::" (a colon and, usually, whitespace) is non-word, so
// \b silently fails to anchor there. That let a shorter, wrong alternative
// (a trailing bare "::\b") win the match on "::1", producing "[IP_1]1"
// instead of masking the whole address.
const IPV6_HEX = "[A-Fa-f0-9]{1,4}";
const IPV6_CORE =
  `(?:${IPV6_HEX}:){7}${IPV6_HEX}` + // full form, all 8 groups present
  `|(?:${IPV6_HEX}:){1,7}:(?:${IPV6_HEX}:){0,6}${IPV6_HEX}` + // "::" compressed, with a group after it
  `|(?:${IPV6_HEX}:){1,7}:` + // "::" compressed, nothing after it
  `|::(?:${IPV6_HEX}:){0,6}${IPV6_HEX}` + // starts with "::"
  `|::`; // bare "::" (unspecified address shorthand)
const IPV6_RE = new RegExp(`(?<![:.\\w])(?:${IPV6_CORE})(?![:.\\w])`, "g");

// Whether private/loopback/link-local addresses (10.0.0.0/8,
// 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16, and their
// IPv6 equivalents ::1 and fe80::/10) get masked too: yes. They aren't
// personal data, but they're still sensitive infra detail -- a private IP
// in a customer's docs can reveal internal network topology or
// segmentation, and this gate runs on the customer's own device before
// anything reaches a cloud model, so the cost of over-masking an internal
// address is a placeholder in a draft rule, not a support ticket. Under-
// masking it is a real disclosure. That asymmetry is why every IP match
// below is masked regardless of range.
function detectIps(text: string): RawMatch[] {
  return [...matchesOf(IPV4_RE, text, "IP"), ...matchesOf(IPV6_RE, text, "IP")];
}

// US-shaped 3-3-4 numbers (with optional country code and/or parens around
// the area code) plus leading-"+" international numbers. Deliberately
// requires a separator (a space, dash, dot, or parens) between groups
// rather than matching bare unbroken digit runs -- an unbroken 10-digit
// string in prose is at least as likely to be an order ID or a database
// key as a phone number, and the task's own false-positive cases
// ("discounts over 15%", "orders over $50") are short enough that this
// wouldn't catch them anyway.
const PHONE_US_RE = /(?:\+\d{1,3}[-.\s]?)?(?:\(\d{3}\)[-.\s]?|\d{3}[-.\s])\d{3}[-.\s]?\d{4}\b/g;
const PHONE_INTL_RE = /\+\d{1,3}(?:[-.\s]?\d{1,4}){2,5}\b/g;

function detectPhones(text: string): RawMatch[] {
  const candidates = [...matchesOf(PHONE_US_RE, text, "PHONE"), ...matchesOf(PHONE_INTL_RE, text, "PHONE")];
  return candidates.filter((match) => {
    const digitCount = match.value.replace(/\D/g, "").length;
    return digitCount >= 7 && digitCount <= 15;
  });
}

// Priority order: most specific/validated first, generic entropy fallback
// last. See resolveOverlaps in ./spans.ts -- earlier entries here claim
// their span before later ones get a chance at overlapping text.
const DETECTORS: Array<(text: string) => RawMatch[]> = [
  detectKeys,
  detectCreditCards,
  detectSsns,
  detectEmails,
  detectIps,
  detectPhones,
  detectHighEntropyTokens,
];

export function runDeterministicLayer(text: string, registry: PlaceholderRegistry): LayerResult {
  const reserved = existingPlaceholderSpans(text);
  const candidates = DETECTORS.flatMap((detector) => detector(text));
  const resolved = resolveOverlaps(candidates, reserved);
  return applyMatches(text, resolved, registry, "deterministic");
}

import { expect, test } from "bun:test";
import { PlaceholderRegistry } from "../../src/privacy-gate/registry.js";
import {
  applyMatches,
  existingPlaceholderSpans,
  passesLuhn,
  PLACEHOLDER_RE,
  resolveOverlaps,
  shannonEntropy,
} from "../../src/privacy-gate/spans.js";
import type { RawMatch } from "../../src/privacy-gate/types.js";

test("finds every supported placeholder and reports its exclusive span", () => {
  const kinds = [
    "PERSON",
    "EMAIL",
    "KEY",
    "CREDIT_CARD",
    "SSN",
    "PHONE",
    "IP",
    "ORG",
    "ADDRESS",
    "AMOUNT",
  ];
  const placeholders = kinds.map((kind, index) => `[${kind}_${index + 1}]`);
  const text = `before ${placeholders.join(" between ")} after`;

  expect([...text.matchAll(PLACEHOLDER_RE)].map((match) => match[0])).toEqual(placeholders);
  expect(existingPlaceholderSpans(text)).toEqual(
    placeholders.map((placeholder) => {
      const start = text.indexOf(placeholder);
      return { start, end: start + placeholder.length };
    }),
  );
});

test("does not reserve malformed or unsupported placeholder-like text", () => {
  const text = "[EMAIL_x] [UNKNOWN_1] [email_2] [EMAIL_3]";

  expect(existingPlaceholderSpans(text)).toEqual([{ start: 32, end: 41 }]);
});

test("resolves candidates in order, respecting reserved spans and adjacent matches", () => {
  const candidates: RawMatch[] = [
    { kind: "EMAIL", value: "first", start: 0, end: 4 },
    { kind: "KEY", value: "overlap", start: 2, end: 6 },
    { kind: "PHONE", value: "adjacent", start: 6, end: 8 },
    { kind: "IP", value: "reserved", start: 9, end: 12 },
  ];
  const reserved = [{ start: 9, end: 12 }];
  const candidatesBefore = structuredClone(candidates);
  const reservedBefore = structuredClone(reserved);

  expect(resolveOverlaps(candidates, reserved)).toEqual([candidates[0], candidates[2]]);
  expect(candidates).toEqual(candidatesBefore);
  expect(reserved).toEqual(reservedBefore);
});

test("applies unsorted matches left-to-right and reuses a value placeholder", () => {
  const email = "jane@example.com";
  const text = `Contact ${email} and ${email}.`;
  const firstStart = text.indexOf(email);
  const secondStart = text.lastIndexOf(email);
  const matches: RawMatch[] = [
    { kind: "EMAIL", value: email, start: secondStart, end: secondStart + email.length },
    { kind: "EMAIL", value: email, start: firstStart, end: firstStart + email.length },
  ];
  const matchesBefore = structuredClone(matches);

  const result = applyMatches(text, matches, new PlaceholderRegistry(), "deterministic");

  expect(result.text).toBe("Contact [EMAIL_1] and [EMAIL_1].");
  expect(result.hits).toEqual([
    {
      placeholder: "[EMAIL_1]",
      kind: "EMAIL",
      layer: "deterministic",
      value: email,
      start: firstStart,
      end: firstStart + email.length,
    },
    {
      placeholder: "[EMAIL_1]",
      kind: "EMAIL",
      layer: "deterministic",
      value: email,
      start: secondStart,
      end: secondStart + email.length,
    },
  ]);
  expect(matches).toEqual(matchesBefore);
});

test("leaves text unchanged when there are no matches", () => {
  const text = "Nothing sensitive here.";

  expect(applyMatches(text, [], new PlaceholderRegistry(), "ner")).toEqual({ text, hits: [] });
});

test("calculates Shannon entropy in bits per character", () => {
  expect(shannonEntropy("")).toBe(0);
  expect(shannonEntropy("aaaa")).toBe(0);
  expect(shannonEntropy("abab")).toBeCloseTo(1);
  expect(shannonEntropy("abcd")).toBeCloseTo(2);
});

test("accepts Luhn-valid card numbers and rejects an invalid checksum", () => {
  expect(passesLuhn("4242424242424242")).toBe(true);
  expect(passesLuhn("4111111111111111")).toBe(true);
  expect(passesLuhn("4242424242424241")).toBe(false);
});

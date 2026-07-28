// End-to-end tests for applyPrivacyGate: the full three-layer pipeline,
// the bidirectional mapping shape task 1.3 will consume, and idempotency
// (running the gate twice must not re-mask its own output).
import { expect, test } from "bun:test";
import { applyPrivacyGate } from "../../src/privacy-gate/index.js";

test("masks deterministic and NER hits together in one run", async () => {
  const text = "Jane Smith works there. Her SSN is 078-05-1120 and her email is jane@acme.com.";
  const result = await applyPrivacyGate(text);
  expect(result.maskedText).toBe(
    "[PERSON_1] works there. Her SSN is [SSN_1] and her email is [EMAIL_1].",
  );
});

test("the mapping reverses exactly in both directions", async () => {
  const text = "Reach Jane Smith at jane@acme.com.";
  const result = await applyPrivacyGate(text);

  const emailPlaceholder = result.mapping.valueToPlaceholder.get("jane@acme.com");
  expect(emailPlaceholder).toBe("[EMAIL_1]");
  expect(result.mapping.placeholderToValue.get(emailPlaceholder as string)).toBe("jane@acme.com");

  const namePlaceholder = result.mapping.valueToPlaceholder.get("Jane Smith");
  expect(namePlaceholder).toBe("[PERSON_1]");
  expect(result.mapping.placeholderToValue.get(namePlaceholder as string)).toBe("Jane Smith");
});

test("every hit's placeholder resolves in the mapping and carries enough for a redaction report", async () => {
  const text = "Card 4242 4242 4242 4242 was charged to jane@acme.com.";
  const result = await applyPrivacyGate(text);

  expect(result.hits.length).toBeGreaterThan(0);
  for (const hit of result.hits) {
    expect(result.mapping.placeholderToValue.get(hit.placeholder)).toBe(hit.value);
    expect(["deterministic", "ner", "contextual"]).toContain(hit.layer);
  }
});

test("running the gate twice does not re-mask its own placeholders", async () => {
  const text = "Jane Smith's SSN is 078-05-1120, email jane@acme.com, at Acme Corporation.";
  const first = await applyPrivacyGate(text);
  const second = await applyPrivacyGate(first.maskedText);

  expect(second.maskedText).toBe(first.maskedText);
  expect(second.hits).toHaveLength(0);
});

test("text that already contains a literal placeholder token is left alone", async () => {
  const result = await applyPrivacyGate("Already redacted: [EMAIL_1] on file.");
  expect(result.maskedText).toBe("Already redacted: [EMAIL_1] on file.");
  expect(result.hits).toHaveLength(0);
});

test("plain policy text with no PII produces no hits and unchanged text", async () => {
  const text = "Refunds over 15% require manager sign-off. Orders over $50 ship free.";
  const result = await applyPrivacyGate(text);
  expect(result.maskedText).toBe(text);
  expect(result.hits).toHaveLength(0);
  expect(result.mapping.valueToPlaceholder.size).toBe(0);
});

test("the same value seen across layers keeps one consistent placeholder", async () => {
  // "Acme Corporation" appears twice; both mentions must collapse onto
  // [ORG_1], not mint a second org placeholder for the repeat.
  const text = "Acme Corporation shipped the order. Acme Corporation also issued the refund.";
  const result = await applyPrivacyGate(text);
  expect(result.maskedText).toBe("[ORG_1] shipped the order. [ORG_1] also issued the refund.");
  expect(result.hits.filter((h) => h.kind === "ORG")).toHaveLength(2);
});

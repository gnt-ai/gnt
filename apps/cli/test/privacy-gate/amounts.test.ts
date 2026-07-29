// Layer 2b (policy-vs-personal amount classification) tests. Two
// sections: the classifier run directly via runAmountsLayer
// (isolated from NER, so it's clear what the classifier itself does with
// an already-placeholdered/possessive-marked input), then end-to-end
// through applyPrivacyGate (so NER's actual output -- including its own
// possessive-splitting quirks, see layer2-ner.ts -- feeds the classifier
// the way it really would in production).
//
// Per the task's own framing, over-masking a policy sentence is the worse
// mistake (it makes an extracted rule useless), so the "keep this" section
// below is the one that has to hold up across the most phrasings.
import { expect, test } from "bun:test";
import { applyPrivacyGate } from "../../src/privacy-gate/index.js";
import { runAmountsLayer } from "../../src/privacy-gate/layer2b-amounts.js";
import { PlaceholderRegistry } from "../../src/privacy-gate/registry.js";

function run(text: string) {
  return runAmountsLayer(text, new PlaceholderRegistry());
}

// -- Layer-level: policy values must survive (no entity/possessive nearby) --

test("does not mask a bare dollar threshold with no entity reference", () => {
  const result = run("Orders over $50 get free shipping.");
  expect(result.text).toBe("Orders over $50 get free shipping.");
  expect(result.hits).toHaveLength(0);
});

test("does not mask a bare percentage threshold with no entity reference", () => {
  const result = run("Refunds over 15% require manager sign-off.");
  expect(result.text).toBe("Refunds over 15% require manager sign-off.");
  expect(result.hits).toHaveLength(0);
});

test("does not mask a dollar threshold phrased as 'under'", () => {
  const result = run("Any purchase under $25 doesn't need a receipt.");
  expect(result.text).toBe("Any purchase under $25 doesn't need a receipt.");
  expect(result.hits).toHaveLength(0);
});

test("does not mask a dollar threshold phrased as a flat statement", () => {
  const result = run("The threshold for automatic approval is $1,000.");
  expect(result.text).toBe("The threshold for automatic approval is $1,000.");
  expect(result.hits).toHaveLength(0);
});

test("does not mask a percentage threshold phrased with 'above'", () => {
  const result = run("Discounts above 20% need approval from a manager.");
  expect(result.text).toBe("Discounts above 20% need approval from a manager.");
  expect(result.hits).toHaveLength(0);
});

test("does not mask a dollar threshold phrased as a conditional clause", () => {
  const result = run("If the refund exceeds $200, escalate to a supervisor.");
  expect(result.text).toBe("If the refund exceeds $200, escalate to a supervisor.");
  expect(result.hits).toHaveLength(0);
});

test("does not mask multiple policy thresholds in the same sentence", () => {
  const text = "Refunds over 15% require manager sign-off. Orders over $50 ship free within 3 days.";
  const result = run(text);
  expect(result.text).toBe(text);
  expect(result.hits).toHaveLength(0);
});

// -- Layer-level: personal values must be masked --

test("masks a dollar amount preceded by a possessive noun", () => {
  const result = run("The customer's balance is $50,000.");
  expect(result.text).toBe("The customer's balance is [AMOUNT_1].");
  expect(result.hits[0]?.kind).toBe("AMOUNT");
  expect(result.hits[0]?.value).toBe("$50,000");
});

test("masks a dollar amount preceded by a possessive pronoun", () => {
  const result = run("Her outstanding balance is $312.50.");
  expect(result.text).toBe("Her outstanding balance is [AMOUNT_1].");
});

test("masks a dollar amount adjacent to an already-masked PERSON placeholder", () => {
  const result = run("[PERSON_1] owes $89.99 on the account.");
  expect(result.text).toBe("[PERSON_1] owes [AMOUNT_1] on the account.");
});

test("masks a dollar amount that comes before the PERSON placeholder that owns it", () => {
  const result = run("$4,392.17 was charged to [PERSON_1].");
  expect(result.text).toBe("[AMOUNT_1] was charged to [PERSON_1].");
});

test("masks a dollar amount adjacent to an already-masked ORG placeholder", () => {
  const result = run("[ORG_1] account balance is $12,000.");
  expect(result.text).toBe("[ORG_1] account balance is [AMOUNT_1].");
});

test("masks a personal percentage preceded by a possessive pronoun", () => {
  const result = run("Her commission is 12% this quarter.");
  expect(result.text).toBe("Her commission is [AMOUNT_1] this quarter.");
});

test("does not misread a non-possessive 's contraction as a possessive marker", () => {
  // "it's" is "it is", not a possessive -- must not trigger a false mask.
  const result = run("Escalate if it's over $50.");
  expect(result.text).toBe("Escalate if it's over $50.");
  expect(result.hits).toHaveLength(0);
});

// -- Layer-level: time-period possessives are not a personal-ownership
// signal -- a calendar noun in possessive form ("this quarter's",
// "today's") matches the same bare "'s" shape as "customer's" but can
// never be the specific person/org a figure personally belongs to.
// Regression coverage for the false positive a tester reported: an
// ordinary policy threshold ("this quarter's revenue target is $50,000")
// was coming out masked.

test("does not mask a dollar threshold after a quarter possessive", () => {
  const result = run("This quarter's revenue target is $50,000.");
  expect(result.text).toBe("This quarter's revenue target is $50,000.");
  expect(result.hits).toHaveLength(0);
});

test("does not mask a percentage threshold after a year possessive", () => {
  const result = run("Last year's discount rate was 15%.");
  expect(result.text).toBe("Last year's discount rate was 15%.");
  expect(result.hits).toHaveLength(0);
});

test("does not mask a dollar threshold after a today possessive", () => {
  const result = run("Today's exchange rate adds 3% to the total.");
  expect(result.text).toBe("Today's exchange rate adds 3% to the total.");
  expect(result.hits).toHaveLength(0);
});

test("does not mask a dollar threshold after a yesterday possessive", () => {
  const result = run("Yesterday's closing price was $50.");
  expect(result.text).toBe("Yesterday's closing price was $50.");
  expect(result.hits).toHaveLength(0);
});

test("does not mask a percentage threshold after a tomorrow possessive", () => {
  const result = run("Tomorrow's rate goes up 5%.");
  expect(result.text).toBe("Tomorrow's rate goes up 5%.");
  expect(result.hits).toHaveLength(0);
});

test("does not mask a dollar threshold after a week possessive", () => {
  const result = run("This week's total was $12,000.");
  expect(result.text).toBe("This week's total was $12,000.");
  expect(result.hits).toHaveLength(0);
});

test("does not mask a percentage threshold after a month possessive", () => {
  const result = run("Last month's growth was 8%.");
  expect(result.text).toBe("Last month's growth was 8%.");
  expect(result.hits).toHaveLength(0);
});

test("still masks a personal amount next to an unrelated time possessive", () => {
  // A real possessive owner elsewhere in the window must still win --
  // this fix only suppresses the time-noun match, not the whole check.
  const result = run("This quarter's numbers are in: Jane's bonus was $4,000.");
  expect(result.text).toBe("This quarter's numbers are in: Jane's bonus was [AMOUNT_1].");
  expect(result.hits[0]?.value).toBe("$4,000");
});

test("masks the surname Day as a real possessive owner", () => {
  // "day's" is deliberately NOT in the time-noun exclusion set -- it
  // collides with the common surname "Day". Without this exclusion,
  // "Robert Day's severance was $120,000" would go unmasked, a real
  // false negative on an actual personal figure.
  const result = run("Robert Day's severance was $120,000.");
  expect(result.text).toBe("Robert Day's severance was [AMOUNT_1].");
  expect(result.hits[0]?.value).toBe("$120,000");
});

// -- Layer-level: documented adversarial/over-masking cases --
// Both of these are real false positives the module accepts on purpose --
// see the "known false-positive failure mode" writeup in
// layer2b-amounts.ts. A fixed-radius text window can't tell a possessive
// or a name that's actually about the figure apart from one that just
// happens to share a sentence with it. Over-masking here (an unnecessary
// [AMOUNT_n] in a draft rule) is deliberately preferred over the
// alternative failure direction, per the plan's own "under-masking leaks"
// framing.

test("adversarial: a generic possessive subject ('the customer's order') still masks a nearby policy-shaped figure", () => {
  const result = run("The customer's order must be over $50 to qualify for free shipping.");
  expect(result.text).toBe("The customer's order must be over [AMOUNT_1] to qualify for free shipping.");
});

test("adversarial: a named speaker earlier in the sentence masks an unrelated policy figure", () => {
  const result = run("[PERSON_1] mentioned that orders over $50 always ship free.");
  expect(result.text).toBe("[PERSON_1] mentioned that orders over [AMOUNT_1] always ship free.");
});

// -- End-to-end through applyPrivacyGate --

test("e2e: masks a customer's invoice amount tied to a name via possessive NER", async () => {
  const result = await applyPrivacyGate("Jane's invoice was $4,392.17.");
  expect(result.maskedText).toBe("[PERSON_1] invoice was [AMOUNT_1].");
  expect(result.mapping.placeholderToValue.get("[AMOUNT_1]")).toBe("$4,392.17");
});

test("e2e: masks a full name's invoice amount despite NER's possessive-splitting quirk", async () => {
  // compromise splits "Jane Smith's" into two person matches ("Jane" and
  // "Smith's") -- see layer2-ner.ts's documented limitation. Both still
  // get masked, and the amount classifier still finds the adjacent
  // [PERSON_2] placeholder regardless of that split.
  const result = await applyPrivacyGate("Jane Smith's invoice was $4,392.17.");
  expect(result.maskedText).toBe("[PERSON_1] [PERSON_2] invoice was [AMOUNT_1].");
});

test("e2e: masks an org's account balance via possessive NER", async () => {
  const result = await applyPrivacyGate("Acme Corporation's account balance is $12,000.");
  expect(result.maskedText).toBe("[ORG_1] account balance is [AMOUNT_1].");
});

test("e2e: keeps a plain policy sentence with a percentage and a dollar threshold untouched", async () => {
  const text = "Refunds over 15% require manager sign-off. Orders over $50 ship free within 3 days.";
  const result = await applyPrivacyGate(text);
  expect(result.maskedText).toBe(text);
  expect(result.hits).toHaveLength(0);
});

test("e2e: a sentence with both a policy threshold and a personal amount masks only the personal one", async () => {
  const text = "Orders over $50 ship free. The customer's balance is $50,000.";
  const result = await applyPrivacyGate(text);
  expect(result.maskedText).toBe("Orders over $50 ship free. The customer's balance is [AMOUNT_1].");
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0]?.kind).toBe("AMOUNT");
  expect(result.hits[0]?.value).toBe("$50,000");
});

test("e2e: the mapping reverses exactly for a masked amount", async () => {
  const result = await applyPrivacyGate("The customer's balance is $50,000.");
  const placeholder = result.mapping.valueToPlaceholder.get("$50,000");
  expect(placeholder).toBe("[AMOUNT_1]");
  expect(result.mapping.placeholderToValue.get(placeholder as string)).toBe("$50,000");
});

test("e2e: running the gate twice does not re-mask an already-masked amount", async () => {
  const first = await applyPrivacyGate("Jane's invoice was $4,392.17.");
  const second = await applyPrivacyGate(first.maskedText);
  expect(second.maskedText).toBe(first.maskedText);
  expect(second.hits).toHaveLength(0);
});

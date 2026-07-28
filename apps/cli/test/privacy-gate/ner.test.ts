// Layer 2 (NER) tests, run directly against runNerLayer so these don't
// depend on layer 1's output. See layer2-ner.ts for the compromise
// library-choice writeup.
import { expect, test } from "bun:test";
import { PlaceholderRegistry } from "../../src/privacy-gate/registry.js";
import { runNerLayer } from "../../src/privacy-gate/layer2-ner.js";

function run(text: string) {
  return runNerLayer(text, new PlaceholderRegistry());
}

test("masks a full person name", () => {
  const result = run("Please contact Jane Smith about the outstanding invoice.");
  expect(result.text).toBe("Please contact [PERSON_1] about the outstanding invoice.");
});

test("masks an organization name", () => {
  const result = run("This handbook belongs to Acme Corporation.");
  expect(result.text).toContain("[ORG_1]");
  expect(result.text).not.toContain("Acme Corporation");
});

test("masks a place name without dragging in trailing sentence punctuation", () => {
  const result = run("Our headquarters is in San Francisco. Remote staff work from home.");
  expect(result.text).toBe("Our headquarters is in [ADDRESS_1]. Remote staff work from home.");
});

test("masks a repeated full name with the same placeholder both times", () => {
  const result = run("Jane Smith filed the ticket. Jane Smith later closed it.");
  expect(result.text).toBe("[PERSON_1] filed the ticket. [PERSON_1] later closed it.");
  expect(result.hits.filter((h) => h.kind === "PERSON")).toHaveLength(2);
});

test("masks person, org, and place together in one pass", () => {
  const result = run("Jane Smith works at Acme Corporation in San Francisco.");
  expect(result.text).toBe("[PERSON_1] works at [ORG_1] in [ADDRESS_1].");
});

test("does not run over spans layer 1 already claimed as placeholders", () => {
  // Simulates layer 1 having already masked an email in this sentence --
  // the NER layer must leave [EMAIL_1] alone rather than trying to tag it
  // as a person or org.
  const result = run("Contact [EMAIL_1] about the Acme Corporation handbook.");
  expect(result.text).toContain("[EMAIL_1]");
  expect(result.text).toContain("[ORG_1]");
  // Only one org placeholder should have been minted -- [EMAIL_1] must not
  // have been reinterpreted as anything and renumbered as, say, [ORG_2].
  expect(result.hits.some((h) => h.placeholder === "[EMAIL_1]")).toBe(false);
});

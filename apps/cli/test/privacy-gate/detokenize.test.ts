// Tests for detokenize: substituting real values back in for placeholder
// tokens after a cloud round-trip. See detokenize.ts for the documented
// "unknown placeholder" decision this test suite pins down.
import { expect, test } from "bun:test";
import { detokenize } from "../../src/privacy-gate/detokenize.js";
import { applyPrivacyGate } from "../../src/privacy-gate/index.js";
import type { PrivacyGateMapping } from "../../src/privacy-gate/types.js";

function mapping(entries: Record<string, string>): PrivacyGateMapping {
  const placeholderToValue = new Map(Object.entries(entries));
  const valueToPlaceholder = new Map(
    [...placeholderToValue.entries()].map(([placeholder, value]) => [value, placeholder]),
  );
  return { valueToPlaceholder, placeholderToValue };
}

test("replaces every occurrence of a repeated placeholder, not just the first", () => {
  const text = "[EMAIL_1] filed a ticket. Reply to [EMAIL_1] directly, cc [EMAIL_1] too.";
  const result = detokenize(text, mapping({ "[EMAIL_1]": "jane@acme.com" }));
  expect(result).toBe(
    "jane@acme.com filed a ticket. Reply to jane@acme.com directly, cc jane@acme.com too.",
  );
});

test("leaves a placeholder-shaped token with no mapping entry as literal text", () => {
  // The model paraphrased and invented [PERSON_3] when this run's gate
  // only ever minted [PERSON_1] and [PERSON_2] -- or hallucinated a token
  // that was never actually masked. Left alone rather than throwing: an
  // unresolved placeholder surfacing in output is a visible, catchable
  // bug, not a reason to blow up the whole pipeline.
  const text = "Escalate to [PERSON_3] for approval.";
  const result = detokenize(text, mapping({ "[PERSON_1]": "Jane Smith" }));
  expect(result).toBe("Escalate to [PERSON_3] for approval.");
});

test("handles multiple different placeholder kinds in one text", () => {
  const text = "[PERSON_1] (owes [AMOUNT_1]) can be reached at [EMAIL_1] or [PHONE_1].";
  const result = detokenize(
    text,
    mapping({
      "[PERSON_1]": "Jane Smith",
      "[AMOUNT_1]": "$4,392.17",
      "[EMAIL_1]": "jane@acme.com",
      "[PHONE_1]": "555-0100",
    }),
  );
  expect(result).toBe("Jane Smith (owes $4,392.17) can be reached at jane@acme.com or 555-0100.");
});

test("empty text returns empty text", () => {
  expect(detokenize("", mapping({ "[EMAIL_1]": "jane@acme.com" }))).toBe("");
});

test("text with no placeholders is returned unchanged", () => {
  const text = "Orders over $50 ship free. No PII here at all.";
  expect(detokenize(text, mapping({ "[EMAIL_1]": "jane@acme.com" }))).toBe(text);
});

test("an empty mapping leaves every placeholder in the text as literal text", () => {
  const text = "Contact [PERSON_1] at [EMAIL_1].";
  const result = detokenize(text, mapping({}));
  expect(result).toBe(text);
});

test("end-to-end: mask, simulate a cloud round-trip that echoes placeholders back, detokenize", async () => {
  const source = "Reach Jane Smith at jane@acme.com.";
  const gateResult = await applyPrivacyGate(source);
  expect(gateResult.maskedText).toBe("Reach [PERSON_1] at [EMAIL_1].");

  // Simulate the cloud model's response: it never saw the real values, so
  // a draft rule it produces can only echo the placeholder tokens
  // verbatim, wrapped in whatever refined wording the model added.
  const cloudResponse = `Rule: when [PERSON_1] emails from [EMAIL_1], route to support.`;

  const restored = detokenize(cloudResponse, gateResult.mapping);

  expect(restored).toBe("Rule: when Jane Smith emails from jane@acme.com, route to support.");
  expect(restored).not.toMatch(/\[[A-Z_]+_\d+\]/);
});

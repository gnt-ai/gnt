// Layer 3 (local-model contextual pass) is a documented no-op stub until
// a real local model runtime gets wired up -- see the writeup
// in layer3-contextual.ts. These tests exist to prove the interface shape
// is right and that it's a true pass-through: layers 1 and 2 still do all
// the work end to end with layer 3 contributing nothing on top.
import { expect, test } from "bun:test";
import { runContextualLayer } from "../../src/privacy-gate/layer3-contextual.js";
import { applyPrivacyGate } from "../../src/privacy-gate/index.js";

test("runContextualLayer returns the input text unchanged with no hits", async () => {
  const text = "the customer's account was flagged, per Jane's usual order.";
  const result = await runContextualLayer(text, new Map());
  expect(result.text).toBe(text);
  expect(result.hits).toEqual([]);
});

test("runContextualLayer accepts the placeholder -> real-value map without using it yet", async () => {
  const placeholders = new Map([["[EMAIL_1]", "jane@acme.com"]]);
  const result = await runContextualLayer("body text with [EMAIL_1] already masked", placeholders);
  expect(result.text).toBe("body text with [EMAIL_1] already masked");
  expect(result.hits).toHaveLength(0);
});

test("layers 1 and 2 still mask everything they can with layer 3 as a no-op", async () => {
  const text = "Reach Jane Smith at jane@acme.com.";
  const result = await applyPrivacyGate(text);
  expect(result.maskedText).toBe("Reach [PERSON_1] at [EMAIL_1].");
  // Every hit came from layer 1 or layer 2 -- layer 3 contributed nothing,
  // which is exactly what the stub is supposed to do today.
  expect(result.hits.every((hit) => hit.layer === "deterministic" || hit.layer === "ner")).toBe(true);
  expect(result.hits.some((hit) => hit.layer === "contextual")).toBe(false);
});

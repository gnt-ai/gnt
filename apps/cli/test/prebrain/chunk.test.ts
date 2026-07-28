// Tests for the shared chunking heuristic (chunk.ts) that every walker
// builds on: heading-driven section boundaries, size-capped paragraph
// grouping, accurate line spans, and the decision-prose keyword signal.
import { expect, test } from "bun:test";
import { chunkText, classifyDecisionProse } from "../../src/prebrain/chunk.js";

test("splits on markdown headings into separate chunks", () => {
  const content = ["# Title", "", "Intro paragraph.", "", "## Refunds", "", "Refund body."].join("\n");
  const chunks = chunkText(content);

  expect(chunks).toHaveLength(2);
  expect(chunks[0].text).toBe("# Title\n\nIntro paragraph.");
  expect(chunks[1].text).toBe("## Refunds\n\nRefund body.");
});

test("line spans are 1-indexed and accurate per chunk, not per file", () => {
  const content = ["# Title", "", "Intro paragraph.", "", "## Refunds", "", "Refund body."].join("\n");
  const chunks = chunkText(content);

  // "# Title" is line 1, "Intro paragraph." is line 3.
  expect(chunks[0].startLine).toBe(1);
  expect(chunks[0].endLine).toBe(3);
  // "## Refunds" is line 5, "Refund body." is line 7.
  expect(chunks[1].startLine).toBe(5);
  expect(chunks[1].endLine).toBe(7);
});

test("groups consecutive small paragraphs under the size cap into one chunk", () => {
  const content = ["First short paragraph.", "", "Second short paragraph.", "", "Third short paragraph."].join("\n");
  const chunks = chunkText(content, 1000);

  expect(chunks).toHaveLength(1);
  expect(chunks[0].text).toBe(
    "First short paragraph.\n\nSecond short paragraph.\n\nThird short paragraph.",
  );
});

test("starts a new chunk once the size cap would be crossed, without splitting a paragraph", () => {
  const paragraphA = "a".repeat(60);
  const paragraphB = "b".repeat(60);
  const paragraphC = "c".repeat(60);
  const content = [paragraphA, "", paragraphB, "", paragraphC].join("\n");

  const chunks = chunkText(content, 100);

  expect(chunks).toHaveLength(3);
  expect(chunks[0].text).toBe(paragraphA);
  expect(chunks[1].text).toBe(paragraphB);
  expect(chunks[2].text).toBe(paragraphC);
});

test("a single paragraph larger than the cap is never split mid-sentence", () => {
  const huge = "This sentence must never be cut in half. ".repeat(50);
  const chunks = chunkText(huge, 200);

  expect(chunks).toHaveLength(1);
  expect(chunks[0].text).toBe(huge.trim());
});

test("plain text with no headings falls back to size-capped paragraph grouping", () => {
  const content = ["lint: enabled", "", "max-line-length: 120", "", "trailing-comma: always"].join("\n");
  const chunks = chunkText(content, 1000);

  expect(chunks).toHaveLength(1);
  expect(chunks[0].text).toContain("lint: enabled");
  expect(chunks[0].text).toContain("trailing-comma: always");
});

test("empty content produces no chunks", () => {
  expect(chunkText("")).toHaveLength(0);
  expect(chunkText("\n\n\n")).toHaveLength(0);
});

test("classifies text with two or more decision-prose signal words as high", () => {
  const text = "Refunds over 15% require manager sign-off. Orders must never ship without approval.";
  expect(classifyDecisionProse(text)).toBe("high");
});

test("classifies text with exactly one decision-prose signal word as medium", () => {
  const text = "This service should respond within 200ms under normal load.";
  expect(classifyDecisionProse(text)).toBe("medium");
});

test("classifies obvious boilerplate as low even though it mentions installation", () => {
  const text = "## Installation\n\nRun `npm install` to install dependencies. See the badge above.";
  expect(classifyDecisionProse(text)).toBe("low");
});

test("classifies plain text with no signal words either way as low", () => {
  const text = "The sky was a flat, even grey over the parking lot that morning.";
  expect(classifyDecisionProse(text)).toBe("low");
});

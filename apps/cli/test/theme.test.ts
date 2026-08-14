// Coverage for theme.ts's pure formatting helpers -- every boxed or wrapped
// line in the CLI goes through these, and the ANSI-aware padding
// (visibleLength vs raw string length) is exactly the kind of thing a
// missing test lets silently regress.
import { expect, test } from "bun:test";
import { box, confidenceColor, error, keyValueLines, muted, success, wrapText } from "../src/theme.js";

// eslint-disable-next-line no-control-regex -- test assertions compare visible CLI output
const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (s: string): string => s.replace(ANSI, "");

test("wrapText wraps a sentence onto lines no wider than the width", () => {
  expect(wrapText("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
});

test("wrapText keeps a word that exactly fills the line on its own line", () => {
  expect(wrapText("ab cd", 2)).toEqual(["ab", "cd"]);
});

test("wrapText hard-chunks a single token longer than the width", () => {
  expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
});

test("wrapText flushes the current line before hard-chunking", () => {
  expect(wrapText("ab abcdefgh", 4)).toEqual(["ab", "abcd", "efgh"]);
});

test("wrapText preserves embedded newlines as blank lines", () => {
  expect(wrapText("a\n\nb", 5)).toEqual(["a", "", "b"]);
});

test("keyValueLines pads values into a column aligned on the longest label", () => {
  const lines = keyValueLines([
    ["a", "1"],
    ["bb", "2"],
    ["ccc", "3"],
  ]);
  expect(lines.map(plain)).toEqual(["a:   1", "bb:  2", "ccc: 3"]);
});

test("keyValueLines returns no lines for no rows", () => {
  expect(keyValueLines([])).toEqual([]);
});

test("box draws a fixed-width frame around its lines", () => {
  const frame = box(["hi"], 2).split("\n");
  expect(frame.map(plain)).toEqual(["┌────┐", "│ hi │", "└────┘"]);
});

test("box pads by visible width, so ANSI colors don't throw off alignment", () => {
  // success("a") is a 1-char string wrapped in escape codes; a length-based
  // pad would see ~20 chars and add nothing, visibly misaligning the box.
  const frame = box([success("a")], 4).split("\n");
  expect(frame.map(plain)).toEqual(["┌──────┐", "│ a    │", "└──────┘"]);
});

test("box leaves an over-width line unpadded instead of truncating it", () => {
  const frame = box(["toolong", "ok"], 4).split("\n");
  expect(frame.map(plain)).toEqual(["┌──────┐", "│ toolong │", "│ ok   │", "└──────┘"]);
});

test("confidenceColor uses the success color at and above 0.8", () => {
  expect(confidenceColor(1.0)).toBe(success);
  expect(confidenceColor(0.8)).toBe(success);
});

test("confidenceColor uses muted between 0.5 and 0.8", () => {
  expect(confidenceColor(0.799)).toBe(muted);
  expect(confidenceColor(0.5)).toBe(muted);
});

test("confidenceColor uses the error color below 0.5", () => {
  expect(confidenceColor(0.499)).toBe(error);
  expect(confidenceColor(0)).toBe(error);
});

import { expect, test } from "bun:test";
import { htmlToText } from "../../src/prebrain/html-to-text.js";

test("strips tags and converts block elements to line breaks", () => {
  const html = "<html><body><p>First paragraph.</p><p>Second paragraph.</p></body></html>";
  expect(htmlToText(html)).toBe("First paragraph.\n\nSecond paragraph.");
});

test("keeps link text with its href alongside it", () => {
  const html = '<p>See <a href="https://example.com/policy">our policy</a> for details.</p>';
  expect(htmlToText(html)).toBe("See our policy (https://example.com/policy) for details.");
});

test("decodes common HTML entities", () => {
  const html = "<p>Ships &amp; handles &mdash; approved &lt;30 days&gt;.</p>";
  expect(htmlToText(html)).toBe("Ships & handles — approved <30 days>.");
});

test("drops script and style elements entirely", () => {
  const html = "<style>.x{color:red}</style><p>Real content.</p><script>alert(1)</script>";
  expect(htmlToText(html)).toBe("Real content.");
});

test("marks a <blockquote> as a '>'-prefixed quote block, same marker plain-text quoting uses", () => {
  const html = "<p>New reply text.</p><blockquote><p>Original message text.</p></blockquote>";
  const text = htmlToText(html);
  expect(text).toContain("New reply text.");
  expect(text).toContain("> Original message text.");
});

test("marks a gmail_quote wrapper div the same way as a blockquote", () => {
  const html = '<p>New reply text.</p><div class="gmail_quote">Original message text.</div>';
  const text = htmlToText(html);
  expect(text).toContain("New reply text.");
  expect(text).toContain("> Original message text.");
});

test("turns list items into '- ' prefixed lines", () => {
  const html = "<ul><li>First item</li><li>Second item</li></ul>";
  const text = htmlToText(html);
  expect(text).toContain("- First item");
  expect(text).toContain("- Second item");
});

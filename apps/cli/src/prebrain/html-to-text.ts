// html-to-text: a small, hand-written HTML-to-text
// converter for email bodies -- not a general-purpose HTML renderer, so
// no new dependency for it (same "bounded, well-documented target" call
// mbox.ts's own doc comment makes). Scope: drop non-content elements
// entirely, turn block-level tags into line breaks, keep link text with
// its href alongside it, decode the handful of entities mail clients
// actually emit. Real CSS layout, tables-as-columns, and nested-list
// indentation are out of scope -- this only has to make an email body
// readable prose for extraction, not pixel-faithful.
//
// Quoted-history blocks (<blockquote>, and Gmail's own
// class="gmail_quote" wrapper) are converted to the same "> "-per-line
// marker plain-text quoting already uses, rather than being stripped
// here. That's mail-chunk.ts's job (stripQuotedContent) -- this module
// only has to make an HTML quote and a plain-text quote look identical
// once both have gone through here, so one quote-stripping heuristic
// downstream covers both, instead of needing an HTML-aware version and a
// plain-text-aware version of the same logic.
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

function markAsQuoted(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

// Strips every remaining tag down to plain text: links keep their text
// with the href noted alongside, <br>/block-closing tags become
// newlines, list items get a "- " marker, everything else is dropped.
function stripToText(html: string): string {
  let text = html;
  text = text.replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const linkText = decodeEntities(inner.replace(/<[^>]+>/g, "").trim());
    if (!linkText) return href;
    return href && href !== linkText ? `${linkText} (${href})` : linkText;
  });
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Paragraph-shaped closes (p/div/heading) get a blank line, the same
  // separation chunk.ts's own block-splitting treats as a real boundary
  // between prose blocks; li/tr just need a line break, not a blank one.
  text = text.replace(/<\/(p|div|h[1-6])>/gi, "\n\n");
  text = text.replace(/<\/(li|tr)>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "- ");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  // A table full of empty cells (or several stacked block tags) can
  // otherwise leave a long wall of blank lines behind -- collapse to at
  // most one blank line between paragraphs.
  text = text.replace(/\n{3,}/g, "\n\n");
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}

export function htmlToText(html: string): string {
  let working = html;
  working = working.replace(/<script[\s\S]*?<\/script>/gi, "");
  working = working.replace(/<style[\s\S]*?<\/style>/gi, "");
  working = working.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) =>
    markAsQuoted(stripToText(inner)),
  );
  working = working.replace(
    /<div[^>]*class="[^"]*gmail_quote[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    (_m, inner: string) => markAsQuoted(stripToText(inner)),
  );
  return stripToText(working);
}

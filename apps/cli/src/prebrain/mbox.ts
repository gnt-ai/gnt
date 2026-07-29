// mbox parsing: splits a Google Takeout mail
// export into individual RFC 5322 messages and parses each one's headers
// and MIME body. Hand-written rather than a dependency (e.g. mailparser)
// -- mbox is a well-documented, bounded text format (a boundary-line
// convention plus RFC 5322/2045 header and MIME rules), the same kind of
// "not especially complex, well-documented" call zip.ts already made for
// the Notion export's .zip format. A full-generality mail library brings
// a much larger dependency (mailparser pulls in iconv-lite, libmime,
// libqp, libbase64, and friends) for handling arbitrary wild-internet
// mail; this walker only has to read what Gmail's own Takeout export
// produces, which is a narrower, more regular target. The scope
// limitations below are the tradeoff for staying dependency-free --
// documented up front, same as zip.ts documents skipping zip64.
//
// Scope, documented rather than discovered late:
//   - The whole file is read as latin1 (a lossless 1 byte : 1 char
//     mapping), not utf-8. Every structural byte in a spec-valid message
//     (mbox boundaries, header names, MIME boundary markers) is plain
//     ASCII regardless of what charset a given part's *body* turns out
//     to be in, so parsing structure on a latin1 read is always safe;
//     decoding a text part's own bytes back out with its declared
//     charset happens separately (see decodeBytes).
//   - Text charset decoding covers what Node's Buffer supports natively
//     (utf-8, latin1/iso-8859-1/ascii, utf-16le) and falls back to utf-8
//     for anything else (shift-jis, gb2312, ...) -- lossy on genuinely
//     rare charsets, never crashing. Real coverage needs iconv-lite;
//     out of scope for an interim connector.
//   - Content-Transfer-Encoding: base64 and quoted-printable are
//     decoded; 7bit/8bit/binary pass through unchanged (already the
//     identity transform for those).
//   - RFC 2047 encoded-word headers (`=?UTF-8?B?...?=`) are decoded for
//     Subject/From/To. Adjacent encoded words separated only by
//     whitespace are not joined per the RFC's own folding rule -- a
//     rare enough case (a single non-ASCII display name almost never
//     spans two encoded words) that it's left as a documented gap
//     rather than handled.
//   - A message with no blank-line header/body separator, or a
//     Content-Type this parser can't make sense of, still returns a
//     best-effort ParsedMailMessage rather than throwing -- callers
//     (gmail-export.ts) skip a message only if parsing throws outright.
import { htmlToText } from "./html-to-text.js";

export interface ParsedMailMessage {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** Decoded display form, e.g. "Jane Doe <jane@acme.com>" -- not yet split into name/address. */
  from: string;
  /** Lowercased bare address extracted from `from`, "" if none could be found. */
  fromAddress: string;
  to: string;
  subject: string;
  date: Date | null;
  /** Best-effort plain text: HTML parts already converted to text, not yet quote-stripped -- that's mail-chunk.ts's job. */
  bodyText: string;
  attachmentNames: string[];
  hasAttachments: boolean;
}

// mboxrd quoting (the convention Google's Takeout export uses): a line
// starting with "From " would be indistinguishable from a real message
// boundary, so a writer prepends one '>' to any body line that, after
// removing all leading '>'s, starts with "From ". A genuine boundary
// line therefore never has a leading '>' -- unescaping strips exactly
// one '>' from any line whose remainder (after all '>'s) starts with
// "From ", and boundary detection is simply "does this raw line, as
// written, start with 'From '".
function isBoundaryLine(line: string): boolean {
  return /^From /.test(line);
}

function unescapeMboxLine(line: string): string {
  return /^>+From /.test(line) ? line.slice(1) : line;
}

// Splits a whole mbox file's contents into raw per-message text (headers
// + body, mboxrd-unescaped), dropping each "From " envelope line itself
// -- that line carries mbox-level envelope metadata (envelope sender,
// arrival timestamp), not RFC 5322 header data, and every message also
// carries its own real Date/From headers a couple of lines below it.
export function splitMboxMessages(raw: string): string[] {
  const lines = raw.split("\n");
  const messages: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (isBoundaryLine(line)) {
      if (current.length > 0) messages.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(unescapeMboxLine(line));
  }
  if (current.length > 0) messages.push(current.join("\n"));

  return messages.filter((m) => m.trim().length > 0);
}

function splitHeadersBody(raw: string): { headerBlock: string; body: string } {
  const idx = raw.indexOf("\n\n");
  if (idx === -1) return { headerBlock: raw, body: "" };
  return { headerBlock: raw.slice(0, idx), body: raw.slice(idx + 2) };
}

// Unfolds RFC 5322 continuation lines (any header line starting with
// whitespace continues the previous header's value) before splitting on
// the first ":" -- a header parsed before unfolding would silently lose
// everything after the first physical line.
function parseHeaders(headerBlock: string): Map<string, string> {
  const rawLines = headerBlock.split("\n");
  const unfolded: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += " " + line.trim();
    } else if (line.trim() !== "") {
      unfolded.push(line);
    }
  }

  const headers = new Map<string, string>();
  for (const line of unfolded) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const name = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    // First occurrence wins -- every header this parser reads
    // (Message-ID, Subject, From, To, Date, Content-Type, ...) is only
    // ever meaningful once; a duplicate is either a malformed message or
    // an unrelated header this parser doesn't read anyway (e.g. multiple
    // "Received" lines).
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}

function decodeBytes(buf: Buffer, charset: string): string {
  const normalized = charset.toLowerCase().trim();
  if (normalized === "utf-8" || normalized === "utf8") return buf.toString("utf-8");
  if (normalized === "us-ascii" || normalized === "ascii") return buf.toString("ascii");
  if (normalized === "iso-8859-1" || normalized === "latin1" || normalized === "windows-1252") {
    return buf.toString("latin1");
  }
  if (normalized === "utf-16le" || normalized === "utf16le") return buf.toString("utf16le");
  return buf.toString("utf-8"); // unsupported charset -- see module doc comment
}

// Decodes a quoted-printable *string built from latin1 char codes* back
// into the original bytes: "=\n" soft line breaks are continuation
// markers and get dropped, "=XX" is a literal byte, anything else passes
// through as its own char code (which is also its own original byte,
// since the source string came from a latin1 read).
function quotedPrintableDecode(input: string): Buffer {
  const joined = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "=" && i + 2 < joined.length && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    bytes.push(joined.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeTransferEncoding(body: string, encoding: string): Buffer {
  const normalized = encoding.toLowerCase().trim();
  if (normalized === "base64") return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (normalized === "quoted-printable") return quotedPrintableDecode(body);
  // 7bit/8bit/binary (and anything unrecognized): identity transform --
  // the latin1-read string's char codes already equal the original bytes.
  return Buffer.from(body, "latin1");
}

// RFC 2047 encoded-word decoding for header values ("=?charset?B|Q?text?=").
const ENCODED_WORD = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;

function decodeEncodedWords(value: string): string {
  return value.replace(ENCODED_WORD, (_match, charset: string, encoding: string, text: string) => {
    try {
      if (encoding.toLowerCase() === "b") {
        return decodeBytes(Buffer.from(text, "base64"), charset);
      }
      // Q-encoding: quoted-printable with "_" standing in for a literal space.
      return decodeBytes(quotedPrintableDecode(text.replace(/_/g, " ")), charset);
    } catch {
      return text; // malformed encoded-word -- keep the raw token rather than losing the header entirely
    }
  });
}

function normalizeMessageId(value: string | undefined | null): string | null {
  if (!value) return null;
  const match = value.match(/<[^<>]+>/);
  const id = (match ? match[0] : value).trim().replace(/^</, "").replace(/>$/, "");
  return id || null;
}

function parseReferences(value: string | undefined): string[] {
  if (!value) return [];
  const matches = value.match(/<[^<>]+>/g);
  if (!matches) return [];
  return matches.map((m) => normalizeMessageId(m)).filter((id): id is string => id !== null);
}

function extractEmailAddress(displayValue: string): string {
  const match = displayValue.match(/<([^<>]+)>/);
  const addr = (match ? match[1] : displayValue).trim();
  return addr.includes("@") ? addr.toLowerCase() : "";
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

interface ContentTypeInfo {
  type: string;
  params: Record<string, string>;
}

// Shared by both Content-Type and Content-Disposition -- both are
// "token; key=value; key=value" shaped, so one parser covers both.
function parseStructuredHeader(value: string | undefined, fallbackType: string): ContentTypeInfo {
  if (!value) return { type: fallbackType, params: {} };
  const segments = value.split(";").map((s) => s.trim());
  const type = (segments[0] || fallbackType).toLowerCase();
  const params: Record<string, string> = {};
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    let val = segment.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { type, params };
}

interface MimePart {
  contentType: string;
  isAttachment: boolean;
  filename?: string;
  textContent?: string; // set for a non-attachment leaf part
  children?: MimePart[]; // set for a multipart/* part
}

// Splits a multipart body on its declared boundary. The text before the
// first boundary (the preamble, e.g. "This is a multi-part message in
// MIME format.") and anything after the closing "--boundary--" (the
// epilogue) are both discarded -- neither is a real part.
function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const segments = body.split(delimiter);
  const parts: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].startsWith("--")) break; // the closing delimiter -- no real part follows
    parts.push(segments[i].replace(/^\r?\n/, ""));
  }
  return parts;
}

function parseMimePart(headers: Map<string, string>, rawBody: string): MimePart {
  const { type, params } = parseStructuredHeader(headers.get("content-type"), "text/plain");
  const disposition = parseStructuredHeader(headers.get("content-disposition"), "inline");
  const filename = disposition.params.filename ?? params.name;
  // Attachment if explicitly disposed as one, or if it declares a
  // filename and isn't a text/multipart part gnt would otherwise read as
  // prose (an inline image with a filename param is still skipped this
  // way, same as an explicit attachment).
  const isAttachment =
    disposition.type === "attachment" || (!!filename && !type.startsWith("text/") && !type.startsWith("multipart/"));

  if (type.startsWith("multipart/") && params.boundary) {
    const children = splitMultipart(rawBody, params.boundary).map((partRaw) => {
      const { headerBlock, body } = splitHeadersBody(partRaw);
      return parseMimePart(parseHeaders(headerBlock), body);
    });
    return { contentType: type, isAttachment: false, children };
  }

  if (isAttachment) {
    return { contentType: type, isAttachment: true, filename };
  }

  if (!type.startsWith("text/")) {
    // A non-text, non-multipart part with neither Content-Disposition nor
    // a filename param is rare but real (older/buggy clients inlining an
    // image without either) -- treated the same as an attachment rather
    // than falling through to decodeBytes below, which would force raw
    // binary bytes through a text decode and put garbage in a chunk.
    return { contentType: type, isAttachment: true, filename };
  }

  const encoding = (headers.get("content-transfer-encoding") ?? "7bit").toLowerCase();
  const charset = params.charset ?? "utf-8";
  const textContent = decodeBytes(decodeTransferEncoding(rawBody, encoding), charset);
  return { contentType: type, isAttachment: false, filename, textContent };
}

function collectAttachmentNames(parts: MimePart[]): string[] {
  return parts.filter((p) => p.isAttachment).map((p) => p.filename ?? "attachment");
}

interface ExtractedBody {
  text: string;
  attachmentNames: string[];
}

// Walks a parsed MIME tree down to a single best-effort text
// representation plus every attachment filename seen along the way.
//   - multipart/alternative: the same content in more than one format --
//     prefer text/plain, fall back to html-to-text on the html branch,
//     never both (that would duplicate the message's own content).
//   - any other multipart/* (mixed, related, ...): siblings meant to be
//     read together (a text body plus an attachment) -- concatenate
//     every non-attachment child's own extracted text.
//   - a leaf part: its own decoded text, HTML converted to plain text
//     first if it's text/html.
function extractBody(part: MimePart): ExtractedBody {
  if (part.isAttachment) {
    return { text: "", attachmentNames: [part.filename ?? "attachment"] };
  }

  if (part.contentType === "multipart/alternative" && part.children) {
    const plain = part.children.find((c) => c.contentType === "text/plain" && !c.isAttachment && c.textContent);
    if (plain?.textContent) return { text: plain.textContent, attachmentNames: collectAttachmentNames(part.children) };
    const html = part.children.find((c) => c.contentType === "text/html" && !c.isAttachment && c.textContent);
    if (html?.textContent) {
      return { text: htmlToText(html.textContent), attachmentNames: collectAttachmentNames(part.children) };
    }
    for (const child of part.children) {
      const nested = extractBody(child);
      if (nested.text) return nested;
    }
    return { text: "", attachmentNames: collectAttachmentNames(part.children) };
  }

  if (part.contentType.startsWith("multipart/") && part.children) {
    const texts: string[] = [];
    const attachmentNames: string[] = [];
    for (const child of part.children) {
      const extracted = extractBody(child);
      if (extracted.text) texts.push(extracted.text);
      attachmentNames.push(...extracted.attachmentNames);
    }
    return { text: texts.join("\n\n"), attachmentNames };
  }

  if (part.contentType === "text/html" && part.textContent) {
    return { text: htmlToText(part.textContent), attachmentNames: [] };
  }
  if (part.textContent) {
    return { text: part.textContent, attachmentNames: [] };
  }
  return { text: "", attachmentNames: [] };
}

// Parses one raw message (headers + body, already mboxrd-unescaped) into
// the shape mail-chunk.ts threads and chunks. Never throws on a
// malformed Content-Type or missing boundary -- extractBody's own
// fallbacks return an empty body in that case rather than this function
// propagating an error; a message this parser genuinely can't make sense
// of at all (no headers, empty input) still returns a message with empty
// fields instead of throwing, so a single bad message can't cost the
// caller the rest of the mbox file.
export function parseMailMessage(raw: string): ParsedMailMessage {
  const { headerBlock, body } = splitHeadersBody(raw);
  const headers = parseHeaders(headerBlock);
  const topPart = parseMimePart(headers, body);
  const extracted = extractBody(topPart);

  const fromRaw = decodeEncodedWords(headers.get("from") ?? "");

  return {
    messageId: normalizeMessageId(headers.get("message-id")),
    inReplyTo: normalizeMessageId(headers.get("in-reply-to")),
    references: parseReferences(headers.get("references")),
    from: fromRaw,
    fromAddress: extractEmailAddress(fromRaw),
    to: decodeEncodedWords(headers.get("to") ?? ""),
    subject: decodeEncodedWords(headers.get("subject") ?? "(no subject)"),
    date: parseDate(headers.get("date")),
    bodyText: extracted.text.trim(),
    attachmentNames: extracted.attachmentNames,
    hasAttachments: extracted.attachmentNames.length > 0,
  };
}

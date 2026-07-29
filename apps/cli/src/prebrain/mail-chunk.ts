// mail-chunk.ts: turns parsed mail messages into
// PrebrainChunks, grouped by reconstructed thread rather than one chunk
// per isolated message -- a lone reply ("approved, go ahead") means
// nothing to extraction without the thread it's replying to; the thread
// is what carries the actual decision.
//
// Deliberately its own module, not an extension of chunk.ts's chunkText:
// chunkText groups blank-line-delimited *paragraph* blocks inside one
// file. This groups whole *messages* inside one thread, and never splits
// a single message's own body across two chunks the way chunkText's
// block-level grouping would allow -- classifyDecisionProse and the
// MAX_CHUNK_CHARS size cap are still reused from chunk.ts, since neither
// of those is paragraph-shaped logic.
//
// The Outlook export walker (.eml/mbox) reuses this module as-is:
// everything below consumes ParsedMailMessage, which mbox.ts produces for
// both the Gmail and Outlook walkers (see outlook-export.ts) -- nothing
// here is mbox-specific.
import { classifyDecisionProse } from "./chunk.js";
import type { ParsedMailMessage } from "./mbox.js";
import type { PrebrainChunk, PrebrainWalker } from "./types.js";

const MAX_CHUNK_CHARS = 1200; // same cap chunk.ts uses, for the same reason: a review-sized excerpt, not a whole-thread dump

export interface MailThread {
  /** Sorted oldest first. */
  messages: ParsedMailMessage[];
}

// Union-find over Message-ID keys, linked by In-Reply-To (the strongest
// signal -- almost always the immediate parent) and References (a
// superset that also catches a thread whose In-Reply-To header a client
// dropped but whose References list still names the earlier messages).
// A message with no Message-ID of its own still gets a synthetic key so
// it becomes its own single-message thread rather than being dropped --
// it just can't ever be referenced as another message's parent, which is
// correct: nothing else could have cited an id that didn't exist.
export function buildThreads(messages: ParsedMailMessage[]): MailThread[] {
  const keys = messages.map((m, i) => m.messageId ?? `__no-id-${i}`);
  const parent = new Map<string, string>(keys.map((k) => [k, k]));

  function find(key: string): string {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = key;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  const knownKeys = new Set(keys);
  for (let i = 0; i < messages.length; i++) {
    const targets = [messages[i].inReplyTo, ...messages[i].references].filter((id): id is string => !!id);
    for (const target of targets) {
      // A reference to a message outside this run (filtered out by
      // --gmail-since/--gmail-from, or just never in the export) has
      // nothing to union with -- that's expected, not an error; scoping
      // a mailbox down can split a thread across two chunks instead of
      // one, which is the accepted tradeoff for scoping it down at all.
      if (knownKeys.has(target)) union(keys[i], target);
    }
  }

  const groups = new Map<string, ParsedMailMessage[]>();
  for (let i = 0; i < messages.length; i++) {
    const root = find(keys[i]);
    const list = groups.get(root) ?? [];
    list.push(messages[i]);
    groups.set(root, list);
  }

  return [...groups.values()].map((msgs) => ({
    messages: [...msgs].sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0)),
  }));
}

// A reply's own new content is almost always everything before the first
// quoted-history marker -- keeping just that stops a long thread from
// reprocessing the same original message once per reply. Two markers are
// recognized:
//   1. A line starting with ">" -- classic plain-text quoting, and also
//      what html-to-text.ts emits for a <blockquote>/gmail_quote block
//      (see that module's own comment for why the two funnel into one
//      marker here).
//   2. An attribution line ("On <date>, <name> wrote:", or a forwarded/
//      original-message separator) -- everything from that line on is
//      dropped along with the quote block it introduces.
// This is a heuristic tuned for the common top-post case (new content
// first, quoted history below), not a full quote-tree parser: a message
// that quotes, adds a paragraph, then quotes again loses that second
// quote too.
const ATTRIBUTION_LINE = /^(On .{0,120}wrote:|-{2,}\s*Forwarded message\s*-{2,}|-{2,}\s*Original Message\s*-{2,})\s*$/i;

export function stripQuotedContent(bodyText: string): string {
  const lines = bodyText.split("\n");
  let cutIndex = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith(">") || ATTRIBUTION_LINE.test(line)) {
      cutIndex = i;
      break;
    }
  }
  return lines.slice(0, cutIndex).join("\n").trim();
}

function formatMessageHeader(msg: ParsedMailMessage): string {
  const when = msg.date ? msg.date.toISOString().slice(0, 10) : "unknown date";
  const attachmentNote = msg.hasAttachments
    ? ` [${msg.attachmentNames.length} attachment${msg.attachmentNames.length === 1 ? "" : "s"}: ${msg.attachmentNames.join(", ")}]`
    : "";
  return `From: ${msg.from || msg.fromAddress || "unknown sender"} on ${when}${attachmentNote}`;
}

interface RenderedMessage {
  lines: string[];
}

function renderMessage(msg: ParsedMailMessage): RenderedMessage {
  const stripped = stripQuotedContent(msg.bodyText);
  const bodyLines = stripped.length > 0 ? stripped.split("\n") : ["(no new content, quoted-only reply)"];
  return { lines: [formatMessageHeader(msg), ...bodyLines] };
}

// Not cryptographic -- just enough entropy that two threads with the
// same slugified subject ("status update", say) get distinguishable
// provenance paths. A short rolling hash is plenty for that.
function shortHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 8);
}

function slugify(subject: string): string {
  const cleaned = subject.replace(/^\s*(re|fwd?)\s*:\s*/i, "").trim();
  const slug = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "no-subject";
}

// Splits one thread's rendered messages into size-capped chunks, never
// splitting a single message's own lines across two chunks -- same
// "a block bigger than the cap still becomes its own chunk" bias
// chunk.ts's chunkText applies to a paragraph block. startLine/endLine
// are offsets into the synthesized per-thread transcript this function
// builds, not into any real file -- see types.ts's own doc comment on
// PrebrainChunk.sourcePath for why (same convention mcp-notion/mcp-monday
// already use for their own non-file sources).
export function threadToChunks(thread: MailThread, walker: PrebrainWalker): PrebrainChunk[] {
  const first = thread.messages[0];
  const rootKey = first?.messageId ?? first?.subject ?? "thread";
  const sourcePath = `threads/${slugify(first?.subject ?? "")}-${shortHash(rootKey)}`;

  const rendered = thread.messages.map(renderMessage);

  const chunks: PrebrainChunk[] = [];
  let group: RenderedMessage[] = [];
  let groupChars = 0;
  let groupStartLine = 1;
  let currentLine = 1;

  const flush = (endLine: number) => {
    if (group.length === 0) return;
    const text = group.map((m) => m.lines.join("\n")).join("\n\n").trim();
    if (text.length > 0) {
      chunks.push({
        text,
        sourcePath,
        startLine: groupStartLine,
        endLine,
        walker,
        looksLikeDecisionProse: classifyDecisionProse(text),
      });
    }
    group = [];
    groupChars = 0;
  };

  for (const msg of rendered) {
    const msgText = msg.lines.join("\n");
    const msgLineCount = msg.lines.length + 1; // +1 for the blank-line separator between messages in the joined text
    const wouldOverflow = groupChars > 0 && groupChars + msgText.length + 2 > MAX_CHUNK_CHARS;
    if (group.length > 0 && wouldOverflow) {
      flush(currentLine - 1);
      groupStartLine = currentLine;
    }
    group.push(msg);
    groupChars += msgText.length + 2;
    currentLine += msgLineCount;
  }
  flush(currentLine - 1);

  return chunks;
}

export function chunkMailThreads(messages: ParsedMailMessage[], walker: PrebrainWalker): PrebrainChunk[] {
  const chunks: PrebrainChunk[] = [];
  for (const thread of buildThreads(messages)) {
    chunks.push(...threadToChunks(thread, walker));
  }
  return chunks;
}

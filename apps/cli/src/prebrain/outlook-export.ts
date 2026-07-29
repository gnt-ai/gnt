// Outlook export walker: reads a portable Outlook
// mail export -- a directory of individual .eml message files, or a
// single mbox-shaped file if the customer bridged their mailbox through a
// tool that produces one -- with zero Microsoft Graph API approval
// needed. Same "interim local path ahead of the real connector" framing
// as gmail-export.ts's own Gmail Takeout walker.
//
// What Outlook's export flow actually supports (see this task's own PR
// description for sources): neither Outlook on the web nor new Outlook
// for Windows can export a whole mailbox to a portable format in one
// step. What both DO support natively, per message, is "download as
// EML"/"save as" .eml -- one file per message. For more than a handful of
// messages, Microsoft's own documented bulk path is the Graph API's
// GET /messages/{id}/$value endpoint, which returns a message's raw MIME
// content, the same shape a .eml file holds -- a customer scripts that
// across a folder's message ids. Neither path ever produces .mbox;
// Outlook doesn't support mbox as an export or import format at all, so
// an .mbox file only shows up here if a customer bridged it through a
// separate tool (e.g. syncing over IMAP into another mail client and
// exporting from there) -- reused as-is via mbox.ts's existing mboxrd
// walker when that happens. Classic Outlook for Windows' Import/Export
// wizard still only writes .pst, Microsoft's proprietary binary mailbox
// format -- explicitly out of scope, same reasoning zip.ts and mbox.ts's
// own doc comments give for skipping a genuinely binary-format tarpit
// instead of a bounded, well-documented text one.
//
// Every message, however it was found, is parsed by mbox.ts's own
// parseMailMessage -- a single RFC 5322 message is a single RFC 5322
// message whether it arrived inside an mbox file or as its own .eml
// file, so this walker reuses that parser directly rather than
// re-deriving header-folding/RFC 2047/quoted-printable/MIME-tree rules a
// second time. Thread reconstruction and quote-stripping are
// mail-chunk.ts's chunkMailThreads, also reused unchanged.
//
// Scope control mirrors --gmail, same reasoning: an export directory can
// be a mailbox's entire history. --outlook-since/--outlook-until/
// --outlook-from bound it (see commands/prebrain.ts for the CLI flags).
//
// Local-only, same as every walker in this directory except the two
// MCP-in ones: no network calls happen anywhere in this file.
import { existsSync, readFileSync, statSync } from "node:fs";
import { chunkMailThreads } from "./mail-chunk.js";
import { parseMailMessage, splitMboxMessages } from "./mbox.js";
import type { ParsedMailMessage } from "./mbox.js";
import { collectFiles } from "./text-walker.js";
import type { PrebrainChunk } from "./types.js";

export interface WalkOutlookExportOptions {
  since?: Date;
  until?: Date;
  /** Lowercased bare addresses ("person@acme.com") or bare domains ("acme.com"). */
  fromFilters?: string[];
}

const EML_EXTENSIONS = [".eml"];

function matchesFromFilter(fromAddress: string, filters: string[] | undefined): boolean {
  if (!filters || filters.length === 0) return true;
  if (!fromAddress) return false;
  return filters.some((filter) => fromAddress === filter || fromAddress.endsWith(`@${filter}`));
}

function passesFilters(msg: ParsedMailMessage, options: WalkOutlookExportOptions): boolean {
  if (options.since && (!msg.date || msg.date < options.since)) return false;
  if (options.until && (!msg.date || msg.date > options.until)) return false;
  return matchesFromFilter(msg.fromAddress, options.fromFilters);
}

// mbox.ts's header/body split and line-folding logic look for a literal
// "\n" between lines throughout (splitHeadersBody finds the blank
// separator as a literal "\n\n", for one) -- true for every mbox.ts/
// gmail-export.ts fixture and for Google's own Takeout mbox export, which
// is LF-only. A real .eml file is a different story: RFC 5322 mandates
// CRLF line endings, and Outlook's own exports follow that, so a raw read
// would leave a stray "\r" sitting between the header block's two "\n"s
// and break the split before parseMailMessage ever runs. Normalizing to
// LF right here, at this walker's own read boundary, fixes that without
// touching mbox.ts's already-tested parsing internals or changing the
// Gmail walker's behavior at all -- an already-LF file (or one using bare
// CR, rare but seen from some older tools) normalizes to itself/to LF and
// is otherwise unaffected.
function normalizeLineEndings(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// mbox's own boundary-line signature (see mbox.ts's isBoundaryLine) --
// sniffing this off the first line is how a single --outlook path is told
// apart as an mbox file rather than a standalone .eml message, without
// trusting the file's extension (a customer's bridging tool might not
// name it *.mbox at all). A real RFC 5322 header never matches this: the
// header name is always immediately followed by ":", never a space, so a
// message that happens to start with a "From" header ("From: ...") can't
// collide with it.
function looksLikeMbox(raw: string): boolean {
  return /^From /.test(raw);
}

export async function walkOutlookExport(
  outlookPath: string,
  options: WalkOutlookExportOptions = {},
): Promise<PrebrainChunk[]> {
  if (!existsSync(outlookPath)) return [];

  const stat = statSync(outlookPath);
  const rawMessages: string[] = [];

  if (stat.isDirectory()) {
    for (const file of collectFiles(outlookPath, EML_EXTENSIONS)) {
      // latin1, not utf-8 -- same reasoning as mbox.ts's own read: a
      // byte-lossless read is always safe for parsing structure, and lets
      // a text part's own declared charset be decoded correctly
      // afterward regardless of what charset the file itself is in.
      rawMessages.push(normalizeLineEndings(readFileSync(file, "latin1")));
    }
  } else if (stat.isFile()) {
    const raw = normalizeLineEndings(readFileSync(outlookPath, "latin1"));
    if (looksLikeMbox(raw)) {
      rawMessages.push(...splitMboxMessages(raw));
    } else {
      rawMessages.push(raw);
    }
  } else {
    return [];
  }

  const messages: ParsedMailMessage[] = [];
  for (const rawMessage of rawMessages) {
    try {
      const parsed = parseMailMessage(rawMessage);
      if (passesFilters(parsed, options)) messages.push(parsed);
    } catch {
      // A malformed individual message never aborts the rest of the
      // export -- same skip-and-report bias every walker here already
      // has (see gmail-export.ts's identical handling).
      continue;
    }
  }

  return chunkMailThreads(messages, "outlook-export");
}

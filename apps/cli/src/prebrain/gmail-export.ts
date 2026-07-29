// Gmail export walker: the interim Gmail path --
// walks a Google Takeout mail export (.mbox) with zero Google OAuth
// approval, ahead of the real Gmail OAuth connector (out of scope here,
// blocked on Google's own app-review process). See mbox.ts for the
// mbox/MIME parsing and mail-chunk.ts for thread reconstruction and
// quote-stripping -- this file is the walker-shaped glue: read the file,
// apply scope filters, hand the surviving messages to the shared mail
// chunker.
//
// Scope control is required, not optional, for a source that can
// otherwise be a mailbox's entire lifetime history in one file:
// --gmail-since/--gmail-until bound the date range, --gmail-from filters
// by sender address or domain (see commands/prebrain.ts/index.ts for the
// CLI flags). The complementary, often better approach needs no flags at
// all -- exporting only specific Gmail labels from Takeout itself -- see
// the docs page (apps/web/app/docs/page.tsx, "Gmail export" tab) for how.
//
// Local-only, same as every walker in this directory except the two
// MCP-in ones: no network calls happen anywhere in this file.
import { existsSync, readFileSync, statSync } from "node:fs";
import { parseMailMessage, splitMboxMessages } from "./mbox.js";
import type { ParsedMailMessage } from "./mbox.js";
import { chunkMailThreads } from "./mail-chunk.js";
import type { PrebrainChunk } from "./types.js";

export interface WalkGmailExportOptions {
  since?: Date;
  until?: Date;
  /** Lowercased bare addresses ("person@acme.com") or bare domains ("acme.com"). */
  fromFilters?: string[];
}

function matchesFromFilter(fromAddress: string, filters: string[] | undefined): boolean {
  if (!filters || filters.length === 0) return true;
  if (!fromAddress) return false;
  return filters.some((filter) => fromAddress === filter || fromAddress.endsWith(`@${filter}`));
}

function passesFilters(msg: ParsedMailMessage, options: WalkGmailExportOptions): boolean {
  if (options.since && (!msg.date || msg.date < options.since)) return false;
  if (options.until && (!msg.date || msg.date > options.until)) return false;
  return matchesFromFilter(msg.fromAddress, options.fromFilters);
}

export async function walkGmailExport(
  mboxPath: string,
  options: WalkGmailExportOptions = {},
): Promise<PrebrainChunk[]> {
  if (!existsSync(mboxPath)) return [];
  if (!statSync(mboxPath).isFile()) return [];

  // latin1, not utf-8 -- see mbox.ts's own doc comment for why a
  // byte-lossless read matters for correctly splitting a file that mixes
  // plain-ASCII structure with arbitrarily-charset-encoded bodies and
  // base64 attachment payloads.
  const raw = readFileSync(mboxPath, "latin1");
  const rawMessages = splitMboxMessages(raw);

  const messages: ParsedMailMessage[] = [];
  for (const rawMessage of rawMessages) {
    try {
      const parsed = parseMailMessage(rawMessage);
      if (passesFilters(parsed, options)) messages.push(parsed);
    } catch {
      // A malformed individual message never aborts the rest of the mbox
      // file -- same skip-and-report bias every walker here already has
      // (see text-walker.ts's own unreadable-file handling).
      continue;
    }
  }

  return chunkMailThreads(messages, "gmail-export");
}

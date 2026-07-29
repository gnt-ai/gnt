// Docs-directory walker: walks a user-pointed directory
// recursively for markdown/text files, skipping node_modules/.git/hidden
// dirs. `gnt prebrain --docs <path>` is the caller; if the path is missing
// or isn't a directory, this returns no chunks rather than throwing -- the
// command layer decides what to print about that, this stays a pure walker.
//
// This is also the walker a customer points at a locally
// synced Dropbox folder -- Dropbox's desktop client syncs to plain files on
// disk, so `--docs <path>` already works against one; the two things below
// make it work well against one specifically.
import { existsSync, statSync } from "node:fs";
import { basename, extname } from "node:path/posix";
import type { PrebrainChunk } from "./types.js";
import { walkTextDir } from "./text-walker.js";

const DOCS_EXTENSIONS = [".md", ".mdx", ".txt"];

// Dropbox's local staging directory. text-walker.ts's own SKIP_DIR_NAMES
// generic rule (any directory name starting with ".") already keeps the
// walker out of it -- this constant exists so that fact is documented next
// to the Dropbox-specific behavior below rather than left implicit, and so
// docs-dir.test.ts has a name to assert against instead of a hardcoded
// string. Not passed to walkTextDir; nothing here needs it.
export const DROPBOX_CACHE_DIR_NAME = ".dropbox.cache";

// Dropbox's desktop client leaves BOTH copies of a file in the synced
// folder when it detects a conflict, renaming only the losing copy. Current
// tag formats, per Dropbox's own help pages (help.dropbox.com/organize/
// conflicted-copy, /case-conflict, /unicode-encoding-conflict):
//   - "<name> (<username>'s conflicted copy <date>).<ext>" -- two devices
//     edited the same file while one was offline. Dropbox's docs describe
//     the tag as "the editor's username, 'conflicted copy', and the save
//     date" without freezing an exact template (a device-name segment
//     shows up in some examples), so this matches on the stable substring
//     rather than a fixed date format.
//   - "<name> (Case Conflict).<ext>" -- same name differing only by case
//     collided on a case-insensitive filesystem.
//   - "<name> (Unicode Encoding Conflict).<ext>" -- same name under two
//     Unicode normalizations collided the same way.
// These three are the patterns Dropbox's support docs confirm as of this
// writing; older client versions are reported to have used other tags
// (e.g. a bare "[Conflicted]" suffix), but nothing currently documented by
// Dropbox uses them, so they aren't matched here.
//
// Decision: ingest the canonical (untagged) filename only, skip every
// tagged variant outright rather than ingesting both or merging them.
// Dropbox never renames the winning copy, so the untagged name is also the
// one a human browsing the folder normally treats as current. Ingesting
// both would either double-count the same content as two sources, or feed
// extraction two chunks that read as contradictory rules when they're
// really one unresolved merge conflict -- worse than dropping content.
// The tradeoff: if the tagged copy holds real material the untagged one
// doesn't, this walker has no way to know that from a directory listing,
// and that content is silently skipped. A customer with unresolved
// conflicts in their synced folder should resolve them in Dropbox (or pull
// the tagged copy's content back into the canonical file by hand) before
// pointing prebrain at it.
const DROPBOX_CONFLICT_SUFFIX =
  /\s\((?:[^()]*conflicted copy[^()]*|case conflict|unicode encoding conflict)\)$/i;

export function isDropboxConflictCopy(fileName: string): boolean {
  const name = basename(fileName);
  const stem = name.slice(0, name.length - extname(name).length);
  return DROPBOX_CONFLICT_SUFFIX.test(stem);
}

export async function walkDocsDir(root: string): Promise<PrebrainChunk[]> {
  if (!existsSync(root)) return [];
  if (!statSync(root).isDirectory()) return [];
  const chunks = await walkTextDir(root, DOCS_EXTENSIONS, "docs-dir");
  return chunks.filter((chunk) => !isDropboxConflictCopy(chunk.sourcePath));
}

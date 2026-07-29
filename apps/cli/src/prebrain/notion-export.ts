// Notion-export walker: given a path to a Notion
// "Markdown & CSV" export .zip (NOT the HTML export), extracts it to a
// local temp dir and walks the resulting .md files the same way docs-dir.ts
// walks a user-pointed directory. See zip.ts's own doc comment for what's
// verified vs. assumed about the export's internal shape.
//
// Deliberately restricted to .md -- unlike docs-dir.ts's [.md, .mdx, .txt],
// a Notion export only ever produces .md (per-page) and .csv (per-database)
// files, plus an assets subfolder of images/attachments per page. .csv rows
// are tabular data, not decision prose, so they're left out rather than
// walked as text; assets are binary and already excluded by the extension
// filter.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractZip } from "./zip.js";
import { walkTextDir } from "./text-walker.js";
import type { PrebrainChunk } from "./types.js";

const NOTION_EXTENSIONS = [".md"];

export async function walkNotionExport(zipPath: string): Promise<PrebrainChunk[]> {
  if (!existsSync(zipPath)) return [];

  const extractDir = mkdtempSync(join(tmpdir(), "gnt-prebrain-notion-"));
  try {
    extractZip(zipPath, extractDir);
    return walkTextDir(extractDir, NOTION_EXTENSIONS, "notion-export");
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

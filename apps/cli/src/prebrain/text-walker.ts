// Shared "walk a directory tree, chunk every matching text file" core --
// both docs-dir.ts and notion-export.ts are this same walk with a
// different extension allowlist and walker tag (notion-export runs it
// against the temp dir a zip was extracted into rather than a
// user-pointed directory directly).
//
// collectFiles itself (just the directory-tree/extension-filter part, not
// the chunk-per-file part below it) is also exported for outlook-export.ts,
// which needs the same tree walk to find .eml files but reads/parses them
// as mail messages, not chunkText's paragraph blocks -- reusing the
// file-discovery half here instead of writing a second directory walker.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { classifyDecisionProse, chunkText } from "./chunk.js";
import type { PrebrainChunk, PrebrainWalker } from "./types.js";

// Noise every reasonable file walker skips -- dependency dirs, VCS
// internals, and hidden directories in general (a user-pointed docs dir or
// a Notion export temp dir has no equivalent of repo-scan's need to look
// inside a specific dotdir like .github).
const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);

// 5MB is generously above any real markdown/text doc -- guards against
// accidentally walking into something huge (a stray export dump, a
// mis-pointed directory) and stalling on it.
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function matchesExtension(filename: string, extensions: readonly string[]): boolean {
  const lower = filename.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

export function collectFiles(root: string, extensions: readonly string[]): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory (permissions, race) -- skip it, not fatal for the whole walk
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // never follow symlinks -- avoids cycles and walking outside root
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(fullPath);
      } else if (entry.isFile() && matchesExtension(entry.name, extensions)) {
        results.push(fullPath);
      }
    }
  }

  walk(root);
  return results;
}

export function walkTextDir(root: string, extensions: readonly string[], walker: PrebrainWalker): PrebrainChunk[] {
  const files = collectFiles(root, extensions);
  const chunks: PrebrainChunk[] = [];

  for (const filePath of files) {
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue; // unreadable file (permissions, race) -- skip it, not fatal for the whole walk
    }

    const sourcePath = relative(root, filePath).split("\\").join("/");
    for (const chunk of chunkText(content)) {
      chunks.push({
        text: chunk.text,
        sourcePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        walker,
        looksLikeDecisionProse: classifyDecisionProse(chunk.text),
      });
    }
  }

  return chunks;
}

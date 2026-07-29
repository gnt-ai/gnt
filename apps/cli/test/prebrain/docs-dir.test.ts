// Tests the docs-directory walker against a real on-disk fixture tree:
// happy path across .md/.mdx/.txt, a missing directory, skipping
// node_modules/.git/hidden-dir/non-markdown noise, and the
// Dropbox-sync-specific quirks: .dropbox.cache never walked, conflicted
// copies recognized and excluded.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDropboxConflictCopy, walkDocsDir } from "../../src/prebrain/docs-dir.js";

let docsRoot: string;

function write(relPath: string, content: string) {
  const fullPath = join(docsRoot, relPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content);
}

beforeEach(() => {
  docsRoot = mkdtempSync(join(tmpdir(), "gnt-prebrain-docs-"));
});

afterEach(() => {
  rmSync(docsRoot, { recursive: true, force: true });
});

test("walks markdown, mdx, and txt files recursively", async () => {
  write("onboarding.md", "# Onboarding\n\nNew hires must complete security training before their first PR.\n");
  write("policies/refunds.mdx", "## Refunds\n\nOrders over $50 ship free; under that, buyer pays shipping.\n");
  write("notes/standup.txt", "Standup notes: nothing decision-worthy here, just a log.\n");

  const chunks = await walkDocsDir(docsRoot);
  const sourcePaths = new Set(chunks.map((c) => c.sourcePath));

  expect(sourcePaths).toContain("onboarding.md");
  expect(sourcePaths).toContain("policies/refunds.mdx");
  expect(sourcePaths).toContain("notes/standup.txt");
  for (const chunk of chunks) {
    expect(chunk.walker).toBe("docs-dir");
  }
});

test("produces line-span provenance that traces back to the source file", async () => {
  write("policy.md", "# Policy\n\nLine three content here.\n");

  const chunks = await walkDocsDir(docsRoot);
  const chunk = chunks.find((c) => c.sourcePath === "policy.md");

  expect(chunk).toBeDefined();
  expect(chunk?.startLine).toBe(1);
  expect(chunk?.endLine).toBeGreaterThanOrEqual(1);
});

test("skips non-markdown/text files, node_modules, and hidden directories", async () => {
  write("real-doc.md", "This is the only file that should be picked up by the walker.\n");
  write("data.json", JSON.stringify({ ignored: true }));
  write("node_modules/some-lib/README.md", "Should never be walked from inside a docs dir either.\n");
  write(".obsidian/workspace.json", "{}");

  const chunks = await walkDocsDir(docsRoot);
  const sourcePaths = chunks.map((c) => c.sourcePath);

  expect(sourcePaths).toEqual(["real-doc.md"]);
});

test("a missing docs directory produces no chunks rather than throwing", async () => {
  const chunks = await walkDocsDir(join(docsRoot, "does-not-exist"));
  expect(chunks).toHaveLength(0);
});

test("a path that is a file, not a directory, produces no chunks", async () => {
  write("not-a-directory.md", "content");
  const chunks = await walkDocsDir(join(docsRoot, "not-a-directory.md"));
  expect(chunks).toHaveLength(0);
});

test("never walks into .dropbox.cache", async () => {
  write("policy.md", "# Policy\n\nThe only real doc in this fixture.\n");
  write(".dropbox.cache/some-staged-file.md", "Dropbox's internal staging copy, never a real doc.\n");

  const chunks = await walkDocsDir(docsRoot);
  const sourcePaths = chunks.map((c) => c.sourcePath);

  expect(sourcePaths).toEqual(["policy.md"]);
});

test("excludes a Dropbox conflicted-copy variant but keeps the canonical file", async () => {
  write("refunds.md", "# Refunds\n\nOrders over $50 ship free.\n");
  write(
    "refunds (jordan's conflicted copy 2026-07-18).md",
    "# Refunds\n\nOrders over $50 ship free, plus a note jordan added offline.\n",
  );

  const chunks = await walkDocsDir(docsRoot);
  const sourcePaths = chunks.map((c) => c.sourcePath);

  expect(sourcePaths).toEqual(["refunds.md"]);
});

test("excludes a Case Conflict variant but keeps the canonical file", async () => {
  write("Onboarding.md", "# Onboarding\n\nCanonical casing, kept.\n");
  write("Onboarding (Case Conflict).md", "# onboarding\n\nCollided on a case-insensitive filesystem.\n");

  const chunks = await walkDocsDir(docsRoot);
  const sourcePaths = chunks.map((c) => c.sourcePath);

  expect(sourcePaths).toEqual(["Onboarding.md"]);
});

test("excludes a Unicode Encoding Conflict variant but keeps the canonical file", async () => {
  write("cafe-notes.md", "# Notes\n\nCanonical normalization, kept.\n");
  write("cafe-notes (Unicode Encoding Conflict).md", "# Notes\n\nSame name, different Unicode normalization.\n");

  const chunks = await walkDocsDir(docsRoot);
  const sourcePaths = chunks.map((c) => c.sourcePath);

  expect(sourcePaths).toEqual(["cafe-notes.md"]);
});

test("a conflicted-copy filename nested in a subdirectory is still excluded", async () => {
  write("policies/refunds.md", "# Refunds\n\nCanonical.\n");
  write("policies/refunds (alex's conflicted copy 2026-06-01).md", "# Refunds\n\nLosing copy.\n");

  const chunks = await walkDocsDir(docsRoot);
  const sourcePaths = chunks.map((c) => c.sourcePath);

  expect(sourcePaths).toEqual(["policies/refunds.md"]);
});

test("isDropboxConflictCopy recognizes every documented tag and leaves ordinary filenames alone", () => {
  expect(isDropboxConflictCopy("notes (jordan's conflicted copy 2026-07-18).md")).toBe(true);
  expect(isDropboxConflictCopy("notes (Alex Chen's conflicted copy on ALEX-LAPTOP 2026-07-18).md")).toBe(true);
  expect(isDropboxConflictCopy("notes (Case Conflict).md")).toBe(true);
  expect(isDropboxConflictCopy("notes (case conflict).MD")).toBe(true);
  expect(isDropboxConflictCopy("notes (Unicode Encoding Conflict).md")).toBe(true);
  expect(isDropboxConflictCopy("notes.md")).toBe(false);
  expect(isDropboxConflictCopy("release notes (final).md")).toBe(false);
  expect(isDropboxConflictCopy("policies/refunds (jordan's conflicted copy 2026-07-18).md")).toBe(true);
});

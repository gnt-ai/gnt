// Exercises the shared directory walker directly so every connector that reuses
// it inherits the same recursion, filtering, safety, and provenance guarantees.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { collectFiles, walkTextDir } from "../../src/prebrain/text-walker.js";

let walkerRoot: string;
let outsideRoot: string;

/** Write one fixture file and create its parent directory when needed. */
function write(root: string, relativePath: string, content: string) {
  const fullPath = join(root, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content);
  return fullPath;
}

/** Normalize fixture paths so assertions are stable across host platforms. */
function relativePaths(paths: string[]): string[] {
  return paths.map((path) => relative(walkerRoot, path).split("\\").join("/")).sort();
}

beforeEach(() => {
  walkerRoot = mkdtempSync(join(tmpdir(), "gnt-text-walker-"));
  outsideRoot = mkdtempSync(join(tmpdir(), "gnt-text-walker-outside-"));
});

afterEach(() => {
  rmSync(walkerRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

test("collects matching extensions recursively and case-insensitively", () => {
  write(walkerRoot, "README.MD", "top-level markdown");
  write(walkerRoot, "policies/refunds.txt", "nested text");
  write(walkerRoot, "policies/data.json", "{}");
  write(walkerRoot, "notes.md.backup", "suffix must match exactly");

  const files = collectFiles(walkerRoot, [".md", ".txt"]);

  expect(relativePaths(files)).toEqual(["README.MD", "policies/refunds.txt"]);
});

test("skips hidden, dependency, and git directories", () => {
  write(walkerRoot, "visible/policy.md", "keep");
  write(walkerRoot, ".hidden/policy.md", "skip");
  write(walkerRoot, "node_modules/example/README.md", "skip");
  write(walkerRoot, ".git/objects/note.md", "skip");

  const files = collectFiles(walkerRoot, [".md"]);

  expect(relativePaths(files)).toEqual(["visible/policy.md"]);
});

test("never follows file or directory symlinks outside the requested root", () => {
  const externalFile = write(outsideRoot, "secret.md", "outside file");
  write(outsideRoot, "directory/nested.md", "outside directory");
  symlinkSync(externalFile, join(walkerRoot, "linked-file.md"));
  symlinkSync(join(outsideRoot, "directory"), join(walkerRoot, "linked-directory"));
  write(walkerRoot, "local.md", "inside file");

  const files = collectFiles(walkerRoot, [".md"]);

  expect(relativePaths(files)).toEqual(["local.md"]);
});

test("returns no files for a missing root or a file path", () => {
  const filePath = write(walkerRoot, "not-a-directory.md", "content");

  expect(collectFiles(join(walkerRoot, "missing"), [".md"])).toEqual([]);
  expect(collectFiles(filePath, [".md"])).toEqual([]);
});

test("emits chunk provenance, walker identity, and decision classification", () => {
  write(
    walkerRoot,
    "policies/refunds.md",
    "# Refund policy\n\nOrders over $50 must be approved before shipping.\n",
  );

  const chunks = walkTextDir(walkerRoot, [".md"], "docs-dir");

  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toEqual({
    text: "# Refund policy\n\nOrders over $50 must be approved before shipping.",
    sourcePath: "policies/refunds.md",
    startLine: 1,
    endLine: 3,
    walker: "docs-dir",
    looksLikeDecisionProse: "high",
  });
});

test("skips files larger than the walker safety limit", () => {
  write(walkerRoot, "small.md", "A normal policy document.");
  write(walkerRoot, "oversized.md", "x".repeat(5 * 1024 * 1024 + 1));

  const chunks = walkTextDir(walkerRoot, [".md"], "docs-dir");

  expect(chunks.map((chunk) => chunk.sourcePath)).toEqual(["small.md"]);
});

// Tests extractZip against real .zip files built with the system `zip`
// binary (present on macOS and on GitHub's ubuntu-latest runner image by
// default) rather than hand-rolled buffers -- this is what actually
// exercises the DEFLATE (method 8) and stored (method 0) code paths
// against archives a real tool produced, the same shape a Notion export
// .zip would be.
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractZip } from "../../src/prebrain/zip.js";

let workDir: string;
let sourceDir: string;
let destDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "gnt-prebrain-zip-"));
  sourceDir = join(workDir, "source");
  destDir = join(workDir, "dest");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(destDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function buildZip(zipName: string, extraArgs: string[] = []): string {
  const zipPath = join(workDir, zipName);
  execFileSync("zip", ["-r", ...extraArgs, zipPath, "."], { cwd: sourceDir });
  return zipPath;
}

test("extracts a deflate-compressed zip, preserving nested structure and content", () => {
  mkdirSync(join(sourceDir, "notes"), { recursive: true });
  writeFileSync(join(sourceDir, "top.md"), "# Top level\n");
  writeFileSync(join(sourceDir, "notes", "nested.md"), "# Nested\n\nSome content.\n");

  const zipPath = buildZip("deflate.zip");
  extractZip(zipPath, destDir);

  expect(readFileSync(join(destDir, "top.md"), "utf-8")).toBe("# Top level\n");
  expect(readFileSync(join(destDir, "notes", "nested.md"), "utf-8")).toBe("# Nested\n\nSome content.\n");
});

test("extracts a stored (uncompressed) zip", () => {
  writeFileSync(join(sourceDir, "stored.txt"), "stored, not compressed\n");

  const zipPath = buildZip("stored.zip", ["-0"]);
  extractZip(zipPath, destDir);

  expect(readFileSync(join(destDir, "stored.txt"), "utf-8")).toBe("stored, not compressed\n");
});

test("throws a clear error on a non-zip file rather than silently producing nothing", () => {
  const garbagePath = join(workDir, "not-a-zip.zip");
  writeFileSync(garbagePath, "definitely not a zip file");

  expect(() => extractZip(garbagePath, destDir)).toThrow(/not a valid zip file/i);
});

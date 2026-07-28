// Tests the Notion-export walker against a real .zip built with the
// system `zip` binary, shaped like Notion's documented "Markdown & CSV"
// export: a page .md file suffixed with a 32-char hex ID, a nested
// subpage folder mirroring the page tree, a per-page assets folder with a
// binary attachment, and a database .csv sitting alongside the pages.
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkNotionExport } from "../../src/prebrain/notion-export.js";

let workDir: string;
let sourceDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "gnt-prebrain-notion-fixture-"));
  sourceDir = join(workDir, "export-root");
  mkdirSync(sourceDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const PAGE_ID = "1234567890abcdef1234567890abcdef";

function buildNotionExportZip(): string {
  const pageFolder = join(sourceDir, `Engineering Handbook ${PAGE_ID}`);
  mkdirSync(pageFolder, { recursive: true });
  writeFileSync(
    join(sourceDir, `Engineering Handbook ${PAGE_ID}.md`),
    "# Engineering Handbook\n\nAll pull requests must have at least one approving review before merge.\n",
  );

  const assetsFolder = join(pageFolder, `Engineering Handbook ${PAGE_ID}`);
  mkdirSync(assetsFolder, { recursive: true });
  writeFileSync(join(assetsFolder, "diagram.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47])); // fake PNG bytes, not a real image

  const subpageId = "abcdef1234567890abcdef1234567890";
  writeFileSync(
    join(pageFolder, `On-call rotation ${subpageId}.md`),
    "# On-call rotation\n\nEscalate to the secondary on-call if the primary hasn't acked within 15 minutes.\n",
  );

  writeFileSync(
    join(sourceDir, `Incident Log ${subpageId}.csv`),
    "Name,Severity,Status\nOutage,SEV1,Resolved\n",
  );

  const zipPath = join(workDir, "notion-export.zip");
  execFileSync("zip", ["-r", zipPath, "."], { cwd: sourceDir });
  return zipPath;
}

test("walks the extracted .md pages and tags every chunk with the notion-export walker", async () => {
  const zipPath = buildNotionExportZip();

  const chunks = await walkNotionExport(zipPath);

  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.walker).toBe("notion-export");
  }
  const combinedText = chunks.map((c) => c.text).join("\n");
  expect(combinedText).toContain("All pull requests must have at least one approving review");
  expect(combinedText).toContain("Escalate to the secondary on-call");
});

test("does not walk the database .csv or the assets folder's binary attachment", async () => {
  const zipPath = buildNotionExportZip();

  const chunks = await walkNotionExport(zipPath);
  const sourcePaths = chunks.map((c) => c.sourcePath);

  expect(sourcePaths.some((p) => p.endsWith(".csv"))).toBe(false);
  expect(sourcePaths.some((p) => p.endsWith(".png"))).toBe(false);
});

test("cleans up its extraction temp dir after walking", async () => {
  const zipPath = buildNotionExportZip();
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith("gnt-prebrain-notion-"));

  await walkNotionExport(zipPath);

  const after = readdirSync(tmpdir()).filter((n) => n.startsWith("gnt-prebrain-notion-"));
  expect(after).toEqual(before);
});

test("a missing zip path produces no chunks rather than throwing", async () => {
  const chunks = await walkNotionExport(join(workDir, "does-not-exist.zip"));
  expect(chunks).toHaveLength(0);
});

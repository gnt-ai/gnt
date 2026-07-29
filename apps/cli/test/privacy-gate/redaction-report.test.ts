// Tests for the redaction report -- the privacy gate's audit trail. Two
// sections: buildRedactionReport (pure content, no I/O, covers every
// PlaceholderKind the layers above it can produce) and writeRedactionReport
// (a real write into a GNT_CONFIG_DIR-scoped tmpdir, matching the pattern
// test/logout.test.ts uses for credentials.ts).
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRedactionReport } from "../../src/privacy-gate/redaction-report.js";
import type { DetectionHit } from "../../src/privacy-gate/types.js";

const FIXED_DATE = new Date("2026-07-18T14:22:03.104Z");

function hit(overrides: Partial<DetectionHit> & Pick<DetectionHit, "placeholder" | "kind" | "layer" | "value">): DetectionHit {
  return { start: 0, end: 0, ...overrides };
}

const ALL_KIND_HITS: DetectionHit[] = [
  hit({ placeholder: "[KEY_1]", kind: "KEY", layer: "deterministic", value: "sk-ant-abc123def456ghi789" }), // gitleaks:allow
  hit({ placeholder: "[EMAIL_1]", kind: "EMAIL", layer: "deterministic", value: "jane@acme.com" }),
  hit({ placeholder: "[PERSON_1]", kind: "PERSON", layer: "ner", value: "Jane Smith" }),
  hit({ placeholder: "[ORG_1]", kind: "ORG", layer: "ner", value: "Acme Corporation" }),
  hit({ placeholder: "[ADDRESS_1]", kind: "ADDRESS", layer: "ner", value: "500 Market St" }),
  hit({ placeholder: "[AMOUNT_1]", kind: "AMOUNT", layer: "amounts", value: "$4,392.17" }),
];

// -- buildRedactionReport: content --

test("covers every kind of hit the gate layers can produce", () => {
  const report = buildRedactionReport(ALL_KIND_HITS, FIXED_DATE);

  expect(report).toContain("`[KEY_1]` <- `sk-ant-abc123def456ghi789` (layer: deterministic)");
  expect(report).toContain("`[EMAIL_1]` <- `jane@acme.com` (layer: deterministic)");
  expect(report).toContain("`[PERSON_1]` <- `Jane Smith` (layer: ner)");
  expect(report).toContain("`[ORG_1]` <- `Acme Corporation` (layer: ner)");
  expect(report).toContain("`[ADDRESS_1]` <- `500 Market St` (layer: ner)");
  expect(report).toContain("`[AMOUNT_1]` <- `$4,392.17` (layer: amounts)");
});

test("groups hits by kind with a per-kind heading and count", () => {
  const report = buildRedactionReport(ALL_KIND_HITS, FIXED_DATE);

  expect(report).toContain("### PERSON (1)");
  expect(report).toContain("### EMAIL (1)");
  expect(report).toContain("### KEY (1)");
  expect(report).toContain("### ORG (1)");
  expect(report).toContain("### ADDRESS (1)");
  expect(report).toContain("### AMOUNT (1)");
});

test("a kind with multiple hits groups them under one heading with the right count", () => {
  const hits: DetectionHit[] = [
    hit({ placeholder: "[EMAIL_1]", kind: "EMAIL", layer: "deterministic", value: "jane@acme.com" }),
    hit({ placeholder: "[EMAIL_2]", kind: "EMAIL", layer: "deterministic", value: "bob@acme.com" }),
  ];
  const report = buildRedactionReport(hits, FIXED_DATE);

  expect(report).toContain("### EMAIL (2)");
  expect(report).toContain("`[EMAIL_1]` <- `jane@acme.com`");
  expect(report).toContain("`[EMAIL_2]` <- `bob@acme.com`");
  // Only one EMAIL section, not one per hit.
  expect(report.match(/### EMAIL/g)).toHaveLength(1);
});

test("summarizes counts by layer", () => {
  const report = buildRedactionReport(ALL_KIND_HITS, FIXED_DATE);

  expect(report).toContain("- deterministic: 2");
  expect(report).toContain("- ner: 3");
  expect(report).toContain("- amounts: 1");
  expect(report).toContain("- contextual: 0");
});

test("records the total item count and the generation timestamp", () => {
  const report = buildRedactionReport(ALL_KIND_HITS, FIXED_DATE);

  expect(report).toContain("total items masked: 6");
  expect(report).toContain(FIXED_DATE.toISOString());
});

test("an empty hits list produces a report saying nothing was masked, not an error", () => {
  const report = buildRedactionReport([], FIXED_DATE);

  expect(report).toContain("total items masked: 0");
  expect(report).toContain("Nothing was masked in this run");
  expect(report).not.toContain("## By kind");
});

// -- writeRedactionReport: real filesystem write --
//
// Sets GNT_CONFIG_DIR to a scratch tmpdir *before* redaction-report.js is
// ever imported, since it reads that env var fresh on every call (same
// convention as credentials.ts) but this still keeps the write clear of a
// real user's actual ~/.gnt/. Dynamic import mirrors test/logout.test.ts.
const testConfigDir = mkdtempSync(join(tmpdir(), "gnt-redaction-report-test-"));
process.env.GNT_CONFIG_DIR = testConfigDir;

const { writeRedactionReport } = await import("../../src/privacy-gate/redaction-report.js");

test("writes the report to GNT_CONFIG_DIR/redaction-reports and returns its path", () => {
  const path = writeRedactionReport(ALL_KIND_HITS, FIXED_DATE);

  expect(path).toBe(join(testConfigDir, "redaction-reports", "redaction-report-2026-07-18T14-22-03-104Z.md"));
  expect(existsSync(path)).toBe(true);

  const written = readFileSync(path, "utf-8");
  expect(written).toBe(buildRedactionReport(ALL_KIND_HITS, FIXED_DATE));

  rmSync(join(testConfigDir, "redaction-reports"), { recursive: true, force: true });
});

test("creates the redaction-reports directory if it doesn't exist yet", () => {
  const reportsDir = join(testConfigDir, "redaction-reports");
  rmSync(reportsDir, { recursive: true, force: true });
  expect(existsSync(reportsDir)).toBe(false);

  writeRedactionReport([], FIXED_DATE);

  expect(existsSync(reportsDir)).toBe(true);
  rmSync(reportsDir, { recursive: true, force: true });
});

test("two runs in the same millisecond-distinct instant get distinct filenames", () => {
  const first = writeRedactionReport(ALL_KIND_HITS, new Date("2026-07-18T14:22:03.104Z"));
  const second = writeRedactionReport(ALL_KIND_HITS, new Date("2026-07-18T14:22:04.104Z"));

  expect(first).not.toBe(second);
  expect(existsSync(first)).toBe(true);
  expect(existsSync(second)).toBe(true);

  rmSync(join(testConfigDir, "redaction-reports"), { recursive: true, force: true });
});

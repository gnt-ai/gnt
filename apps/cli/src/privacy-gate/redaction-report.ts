import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DetectionHit, GateLayer, PlaceholderKind } from "./types.js";

// This is the audit trail behind the privacy gate: every run writes a local
// redaction report -- what was masked, by which layer, with the mapping,
// stored only on the customer's device. It's what makes "your raw data
// never touches gnt's servers" inspectable rather than a bare claim --
// anyone can open this file after a gate run and see exactly what got
// replaced and why. Pure local file I/O, no network call, same
// local-first constraint as the rest of this module (see index.ts).
//
// Split into two pieces on purpose: buildRedactionReport turns hits into
// report text with no I/O, so its output is easy to assert on directly in
// tests. writeRedactionReport is the thin piece that actually touches
// disk. Same shape as spans.ts splitting applyMatches/resolveOverlaps/
// shannonEntropy into single-purpose functions rather than one do-it-all
// pass.

// GNT_CONFIG_DIR override + fresh-read-per-call, same convention as
// credentials.ts (see that file's own comment): bun test runs every
// test/*.test.ts file in one shared process with one shared module cache,
// so freezing this into a module-level const would only ever pick up
// whichever test file's GNT_CONFIG_DIR happened to be set first.
function configDir(): string {
  return process.env.GNT_CONFIG_DIR ?? join(homedir(), ".gnt");
}

function redactionReportsDir(): string {
  return join(configDir(), "redaction-reports");
}

// Report ordering, most identity-revealing first -- matches the
// PlaceholderKind declaration order in types.ts so this report's section
// order stays in sync with that file rather than drifting independently.
const KIND_ORDER: PlaceholderKind[] = [
  "PERSON",
  "EMAIL",
  "KEY",
  "CREDIT_CARD",
  "SSN",
  "PHONE",
  "IP",
  "ORG",
  "ADDRESS",
  "AMOUNT",
];

// Pipeline order, matching the layer sequence documented in index.ts.
const LAYER_ORDER: GateLayer[] = ["deterministic", "ner", "amounts", "contextual"];

function groupByKind(hits: DetectionHit[]): Map<PlaceholderKind, DetectionHit[]> {
  const groups = new Map<PlaceholderKind, DetectionHit[]>();
  for (const hit of hits) {
    const bucket = groups.get(hit.kind);
    if (bucket) bucket.push(hit);
    else groups.set(hit.kind, [hit]);
  }
  return groups;
}

function countByLayer(hits: DetectionHit[]): Map<GateLayer, number> {
  const counts = new Map<GateLayer, number>();
  for (const hit of hits) {
    counts.set(hit.layer, (counts.get(hit.layer) ?? 0) + 1);
  }
  return counts;
}

// Builds the report's full text content from one gate run's hits. Pure
// function, no I/O -- lets tests assert on report content directly
// without touching a filesystem. `generatedAt` defaults to "now" but is a
// parameter so tests (and writeRedactionReport, so the two stay in sync)
// can pin it to a fixed value.
export function buildRedactionReport(hits: DetectionHit[], generatedAt: Date = new Date()): string {
  const lines: string[] = [
    "# gnt privacy gate -- redaction report",
    "",
    `- generated: ${generatedAt.toISOString()}`,
    `- total items masked: ${hits.length}`,
    "",
    "This is the local audit trail for one privacy-gate run: every value",
    "that was replaced with a placeholder before any text left this",
    "device, grouped by what kind of value it was and which layer caught",
    "it. Stored only on this machine, under ~/.gnt/redaction-reports/ --",
    "gnt's servers never see this file or the values it records.",
    "",
  ];

  if (hits.length === 0) {
    lines.push("Nothing was masked in this run -- no PII detected.");
    return lines.join("\n");
  }

  lines.push("## By kind", "");
  const byKind = groupByKind(hits);
  for (const kind of KIND_ORDER) {
    const kindHits = byKind.get(kind);
    if (!kindHits || kindHits.length === 0) continue;
    lines.push(`### ${kind} (${kindHits.length})`, "");
    for (const hit of kindHits) {
      lines.push(`- \`${hit.placeholder}\` <- \`${hit.value}\` (layer: ${hit.layer})`);
    }
    lines.push("");
  }

  lines.push("## By layer", "");
  const byLayer = countByLayer(hits);
  for (const layer of LAYER_ORDER) {
    lines.push(`- ${layer}: ${byLayer.get(layer) ?? 0}`);
  }

  return lines.join("\n");
}

// Per-run filename: a sortable UTC timestamp keeps reports in run order
// on disk with no separate index needed, and colons/periods are stripped
// since they're awkward or outright invalid in filenames on some
// filesystems (NTFS rejects a literal ":").
function redactionReportFilename(generatedAt: Date): string {
  return `redaction-report-${generatedAt.toISOString().replace(/[:.]/g, "-")}.md`;
}

// Writes one gate run's redaction report to ~/.gnt/redaction-reports/ (or
// GNT_CONFIG_DIR/redaction-reports/ under test), creating the directory if
// needed, and returns the path written. Same file-permission convention as
// credentials.ts's credentials.json: 0o700 on the directory, 0o600 on the
// file, since this report contains real customer PII by definition -- it's
// the un-masked mapping written back out in readable form.
export function writeRedactionReport(hits: DetectionHit[], generatedAt: Date = new Date()): string {
  const content = buildRedactionReport(hits, generatedAt);
  const dir = redactionReportsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, redactionReportFilename(generatedAt));
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

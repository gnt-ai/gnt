#!/usr/bin/env bun
// The thing that actually runs eval/privacy-gate/corpus.jsonl through the
// real applyPrivacyGate and scores it -- mirrors the split between
// harness.py (pure scoring) and generate_baseline.py/store_harness.py
// (the thing that talks to something real) in apps/api/eval/rule_retrieval.
//
// No live/paid calls happen anywhere in this call graph -- the privacy
// gate is 100% local, so unlike the rule-retrieval eval this can just run
// for real, every time, instead of replaying a precomputed fixture. See
// README.md for the full reasoning.
//
// Usage:
//   bun run eval/privacy-gate/run.ts                  # print the report
//   bun run eval/privacy-gate/run.ts --write-baseline  # also write baseline.json

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyPrivacyGate } from "../../src/privacy-gate/index.js";
import { loadCorpus, reportToBaseline, runPrivacyGateQuality } from "./harness.js";
import type { BucketReport } from "./harness.js";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));

function loadCorpusFile() {
  const jsonl = readFileSync(join(EVAL_DIR, "corpus.jsonl"), "utf8");
  return loadCorpus(jsonl);
}

function formatBucket(bucket: BucketReport): string {
  const recallPct = (bucket.recall * 100).toFixed(1).padStart(5);
  const fpPct = (bucket.falsePositiveRate * 100).toFixed(1).padStart(5);
  return (
    `${bucket.name.padEnd(16)} recall=${recallPct}% (${bucket.maskFound}/${bucket.maskTotal})  ` +
    `false-positive-rate=${fpPct}% (${bucket.keepTotal - bucket.keepHeld}/${bucket.keepTotal} over-masked)`
  );
}

async function main() {
  const cases = loadCorpusFile();
  console.log(`running ${cases.length} cases through the real privacy gate...\n`);

  const report = await runPrivacyGateQuality(cases, async (text) => {
    const result = await applyPrivacyGate(text);
    return { maskedText: result.maskedText, hits: result.hits };
  });

  console.log(formatBucket(report.overall));
  console.log("\nby category:");
  for (const bucket of report.byCategory) console.log("  " + formatBucket(bucket));
  console.log("\nby layer:");
  for (const bucket of report.byLayer) console.log("  " + formatBucket(bucket));

  const missedCases = report.caseResults.filter((r) => r.missed.length > 0);
  if (missedCases.length > 0) {
    console.log(`\n${missedCases.length} case(s) with at least one missed mask:`);
    for (const result of missedCases) {
      console.log(`  ${result.id} [${result.category}]: missed ${result.missed.map((m) => JSON.stringify(m.value)).join(", ")}`);
    }
  }

  const overMaskedCases = report.caseResults.filter((r) => r.overMasked.length > 0);
  if (overMaskedCases.length > 0) {
    console.log(`\n${overMaskedCases.length} case(s) with at least one over-masked span:`);
    for (const result of overMaskedCases) {
      console.log(`  ${result.id} [${result.category}]: over-masked ${result.overMasked.map((m) => JSON.stringify(m)).join(", ")}`);
    }
  }

  if (process.argv.includes("--write-baseline")) {
    const baseline = reportToBaseline(report);
    writeFileSync(join(EVAL_DIR, "baseline.json"), JSON.stringify(baseline, null, 2) + "\n");
    console.log(`\nwrote ${join(EVAL_DIR, "baseline.json")}`);
  }
}

main();

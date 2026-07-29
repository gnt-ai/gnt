// CI gate for privacy-gate quality regression.
//
// Runs every case in eval/privacy-gate/corpus.jsonl through the real
// applyPrivacyGate (no fixtures, no replay -- the gate is 100% local, so
// this just runs for real, same as every other test in this suite) and
// fails the build if recall/false-positive-rate regress below the
// recorded baseline (eval/privacy-gate/baseline.json) by more than
// TOLERANCE. Mirrors apps/api/tests/test_retrieval_eval.py's shape.
//
// This is what makes "measured, not promised" enforceable rather than a
// one-time README claim: a change to any layer that quietly drops
// coverage on a corpus case fails this test, not just the numbers in a
// doc nobody re-reads. See eval/privacy-gate/README.md for the recorded
// baseline, what it means, and how to regenerate it after a corpus edit.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import { applyPrivacyGate } from "../../src/privacy-gate/index.js";
import { loadCorpus, runPrivacyGateQuality, type BucketReport } from "../../eval/privacy-gate/harness.js";

const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "eval", "privacy-gate");

// Absolute tolerance per metric, not exact equality -- the corpus and the
// gate are both fixed and deterministic, so a rerun against unchanged
// code reproduces the exact baseline; the floor buffer exists so this
// doesn't fail over noise (there shouldn't be any, but see
// test_retrieval_eval.py's identical reasoning for why a hard floor
// beats exact equality as a rule).
const TOLERANCE = 0.02;
const METRICS = ["recall", "falsePositiveRate"] as const;

interface Baseline {
  totalCases: number;
  overall: BucketReport;
  byCategory: BucketReport[];
  byLayer: BucketReport[];
}

function loadCorpusFile() {
  return loadCorpus(readFileSync(join(EVAL_DIR, "corpus.jsonl"), "utf8"));
}

function loadBaseline(): Baseline {
  return JSON.parse(readFileSync(join(EVAL_DIR, "baseline.json"), "utf8")) as Baseline;
}

test("eval corpus covers all three categories with a real corpus, not a token gesture", () => {
  const cases = loadCorpusFile();
  expect(cases.length).toBeGreaterThanOrEqual(50);
  expect(new Set(cases.map((c) => c.category))).toEqual(
    new Set(["contextual", "policy_vs_pii", "secrets_in_prose"]),
  );
});

test("privacy gate quality meets the recorded baseline", async () => {
  const cases = loadCorpusFile();
  const baseline = loadBaseline();

  const report = await runPrivacyGateQuality(cases, async (text) => {
    const result = await applyPrivacyGate(text);
    return { maskedText: result.maskedText, hits: result.hits };
  });

  const failures: string[] = [];

  function checkBucket(current: BucketReport, recorded: BucketReport | undefined, label: string) {
    if (!recorded) return; // a newly added bucket has no recorded floor yet
    for (const metric of METRICS) {
      const got = current[metric];
      // falsePositiveRate regresses when it goes UP, not down -- a lower
      // false-positive rate than baseline is an improvement, not a
      // regression, so the floor direction flips for that one metric.
      const floor = metric === "falsePositiveRate" ? recorded[metric] + TOLERANCE : recorded[metric] - TOLERANCE;
      const regressed = metric === "falsePositiveRate" ? got > floor : got < floor;
      if (regressed) {
        failures.push(`${label}.${metric}: got ${got.toFixed(3)}, floor ${floor.toFixed(3)} (recorded baseline ${recorded[metric].toFixed(3)})`);
      }
    }
  }

  checkBucket(report.overall, baseline.overall, "overall");

  const baselineByCategory = new Map(baseline.byCategory.map((b) => [b.name, b]));
  for (const bucket of report.byCategory) checkBucket(bucket, baselineByCategory.get(bucket.name), bucket.name);

  const baselineByLayer = new Map(baseline.byLayer.map((b) => [b.name, b]));
  for (const bucket of report.byLayer) checkBucket(bucket, baselineByLayer.get(bucket.name), bucket.name);

  expect(failures, "privacy-gate quality regressed below the recorded baseline:\n" + failures.join("\n")).toHaveLength(0);
});

// Layer 3 is a documented no-op today, and this corpus's
// contextual-identifier cases have no name, no pattern --
// nothing layers 1/2/2b could catch even by accident. This assertion
// exists so the moment a real contextual layer lands,
// this test breaks loudly (rather than the corpus silently going stale)
// and someone has to come update this test and the recorded baseline
// together, which is exactly the point where "no-op" stops being true.
test("layer 3 (contextual) currently catches none of the contextual-identifier corpus -- known, measured gap until a real contextual layer lands", async () => {
  const cases = loadCorpusFile().filter((c) => c.category === "contextual");
  expect(cases.length).toBeGreaterThan(0);

  const report = await runPrivacyGateQuality(cases, async (text) => {
    const result = await applyPrivacyGate(text);
    return { maskedText: result.maskedText, hits: result.hits };
  });

  expect(report.overall.recall).toBe(0);
});

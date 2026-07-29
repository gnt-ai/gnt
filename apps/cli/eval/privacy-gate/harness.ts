// Privacy-gate quality harness (the corpus/measured-recall half;
// open-sourcing the module is a separate decision and not this file's
// concern).
//
// Mirrors the shape of apps/api/eval/rule_retrieval/harness.py: pure
// scoring, no knowledge of how a result was produced. This module never
// calls applyPrivacyGate itself -- see run.ts for the thing that actually
// runs the corpus through the real gate. That split means the scoring
// math here is directly unit-testable against synthetic inputs (see
// test/privacy-gate/eval-harness.test.ts), independent of NER/regex
// behavior drifting for unrelated reasons.
//
// Unlike the rule-retrieval eval, there's no paid API and nothing to
// precompute/replay -- the privacy gate is 100% local, deterministic/
// heuristic code, so run.ts calls the real applyPrivacyGate for real,
// every time. See eval/privacy-gate/README.md for the full writeup.

import type { DetectionHit, GateLayer } from "../../src/privacy-gate/types.js";

export type EvalCategory = "contextual" | "policy_vs_pii" | "secrets_in_prose";

// A single real value the gate is expected to mask, and which layer is
// expected to be the one that catches it. `layer` is what makes the
// per-layer recall breakdown possible -- see aggregateByLayer below.
export interface ExpectedMask {
  value: string;
  layer: GateLayer;
}

// One corpus entry. `shouldKeep` is optional: most secrets_in_prose and
// contextual cases only assert recall (things that must get masked);
// policy_vs_pii cases lean on `shouldKeep` more heavily, since "does not
// mask a policy sentence" is exactly the boundary that category stresses.
export interface CorpusCase {
  id: string;
  category: EvalCategory;
  text: string;
  shouldMask: ExpectedMask[];
  shouldKeep?: string[];
  notes?: string;
}

// The subset of PrivacyGateResult the scorer actually needs -- kept
// narrow so a synthetic test can construct one by hand without pulling in
// the real gate or a full mapping.
export interface GateOutcome {
  maskedText: string;
  hits: DetectionHit[];
}

export interface CaseResult {
  id: string;
  category: EvalCategory;
  matched: ExpectedMask[];
  missed: ExpectedMask[];
  keptOk: string[];
  // A shouldKeep value the gate masked anyway (a false positive) or that
  // no longer appears literally in the output for some other reason.
  overMasked: string[];
}

// Scores one case against the gate's real output for that case's text.
// Pure and synchronous: whether a value counts as "masked" is decided by
// exact string match against a hit's recorded value, so this never has to
// re-derive detector behavior or guess at span boundaries -- it only asks
// "did any layer produce a hit for exactly this substring."
export function scoreCase(kase: CorpusCase, outcome: GateOutcome): CaseResult {
  const hitValues = new Set(outcome.hits.map((hit) => hit.value));

  const matched = kase.shouldMask.filter((expected) => hitValues.has(expected.value));
  const missed = kase.shouldMask.filter((expected) => !hitValues.has(expected.value));

  const shouldKeep = kase.shouldKeep ?? [];
  const overMasked = shouldKeep.filter(
    (value) => hitValues.has(value) || !outcome.maskedText.includes(value),
  );
  const keptOk = shouldKeep.filter((value) => !overMasked.includes(value));

  return { id: kase.id, category: kase.category, matched, missed, keptOk, overMasked };
}

export interface BucketReport {
  name: string;
  maskTotal: number;
  maskFound: number;
  recall: number;
  keepTotal: number;
  keepHeld: number;
  // Fraction of documented "must survive untouched" spans the gate masked
  // anyway. Not a full precision score (this corpus doesn't annotate
  // every non-secret token in every case as a true negative) -- it's a
  // targeted false-positive rate over the spans this corpus specifically
  // asserts should be left alone. See README.md for why this is the
  // meaningful number here rather than a textbook precision calculation.
  falsePositiveRate: number;
}

function buildBucket(name: string, results: CaseResult[]): BucketReport {
  const maskTotal = results.reduce((sum, r) => sum + r.matched.length + r.missed.length, 0);
  const maskFound = results.reduce((sum, r) => sum + r.matched.length, 0);
  const keepTotal = results.reduce((sum, r) => sum + r.keptOk.length + r.overMasked.length, 0);
  const keepHeld = results.reduce((sum, r) => sum + r.keptOk.length, 0);
  return {
    name,
    maskTotal,
    maskFound,
    recall: maskTotal === 0 ? 1 : maskFound / maskTotal,
    keepTotal,
    keepHeld,
    falsePositiveRate: keepTotal === 0 ? 0 : 1 - keepHeld / keepTotal,
  };
}

export interface QualityReport {
  totalCases: number;
  overall: BucketReport;
  byCategory: BucketReport[];
  byLayer: BucketReport[];
  caseResults: CaseResult[];
}

// Groups case-level results into per-category and per-layer buckets.
// Per-layer grouping is keyed off each ExpectedMask's declared `layer`
// (which layer *should* catch it), not off which layer actually produced
// the hit -- for the categories in this corpus the two always coincide by
// construction (a secrets_in_prose case's shouldMask entries are always
// declared "deterministic", policy_vs_pii's are always "amounts",
// contextual's are always "contextual"), so this is equivalent in
// practice and simpler to compute.
function aggregateByCategory(results: CaseResult[]): BucketReport[] {
  const byCategory = new Map<EvalCategory, CaseResult[]>();
  for (const result of results) {
    const bucket = byCategory.get(result.category) ?? [];
    bucket.push(result);
    byCategory.set(result.category, bucket);
  }
  return [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, items]) => buildBucket(category, items));
}

function aggregateByLayer(results: CaseResult[]): BucketReport[] {
  // Reshape into one pseudo-result per (case, expected-mask) pair so
  // buildBucket's matched/missed counting works unchanged, grouped by the
  // mask's declared layer instead of the case's category.
  const byLayer = new Map<GateLayer, CaseResult[]>();
  for (const result of results) {
    for (const expected of result.matched) {
      const bucket = byLayer.get(expected.layer) ?? [];
      bucket.push({ ...result, matched: [expected], missed: [], keptOk: [], overMasked: [] });
      byLayer.set(expected.layer, bucket);
    }
    for (const expected of result.missed) {
      const bucket = byLayer.get(expected.layer) ?? [];
      bucket.push({ ...result, matched: [], missed: [expected], keptOk: [], overMasked: [] });
      byLayer.set(expected.layer, bucket);
    }
  }
  return [...byLayer.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([layer, items]) => buildBucket(layer, items));
}

export type GateFn = (text: string) => Promise<GateOutcome>;

// Runs every case through `gateFn` and scores it. A gateFn failure scores
// as a total miss (no hits, unchanged text) rather than aborting the
// whole run, matching run_retrieval_quality's same reasoning in the
// rule-retrieval harness: one broken case shouldn't hide the numbers for
// the other 60+.
export async function runPrivacyGateQuality(
  cases: CorpusCase[],
  gateFn: GateFn,
): Promise<QualityReport> {
  const caseResults: CaseResult[] = [];
  for (const kase of cases) {
    let outcome: GateOutcome;
    try {
      outcome = await gateFn(kase.text);
    } catch {
      outcome = { maskedText: kase.text, hits: [] };
    }
    caseResults.push(scoreCase(kase, outcome));
  }

  return {
    totalCases: caseResults.length,
    overall: buildBucket("overall", caseResults),
    byCategory: aggregateByCategory(caseResults),
    byLayer: aggregateByLayer(caseResults),
    caseResults,
  };
}

export function loadCorpus(jsonlText: string): CorpusCase[] {
  return jsonlText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CorpusCase);
}

// Serializes the metrics that matter for baseline.json -- case-level
// detail stays out of the committed baseline (it's regenerable from the
// corpus + a run) so a corpus edit doesn't produce a noisy diff full of
// per-case bookkeeping.
export function reportToBaseline(report: QualityReport): object {
  const strip = ({ name, maskTotal, maskFound, recall, keepTotal, keepHeld, falsePositiveRate }: BucketReport) => ({
    name,
    maskTotal,
    maskFound,
    recall,
    keepTotal,
    keepHeld,
    falsePositiveRate,
  });
  return {
    totalCases: report.totalCases,
    overall: strip(report.overall),
    byCategory: report.byCategory.map(strip),
    byLayer: report.byLayer.map(strip),
  };
}

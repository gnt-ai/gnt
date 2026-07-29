// CI gate for extraction quality regression.
//
// Unlike test/privacy-gate/eval-gate.test.ts (which runs its real,
// 100%-local gate on every `bun test`, for free), extraction quality can
// only be measured by actually calling the model under test -- there's no
// fixed "correct" output to precompute and replay. So this file splits
// into two tests with very different cost profiles:
//
//   1. A cheap, always-run structural check on corpus.jsonl itself (no
//      model call, no network) -- catches a corpus edit that silently
//      drops a category or shrinks below the floor.
//   2. The real gate: runs every document through the real cloud
//      extraction path (extractRules, mode "cloud", claude-haiku-4-5) and
//      fails the build if recall/precision regress below the recorded
//      baseline (eval/extraction/baseline.json) by more than TOLERANCE.
//      This makes a REAL, PAID Anthropic API call per document, so it
//      only runs when ANTHROPIC_API_KEY is set in the environment --
//      test.skipIf means it's a no-op (not a failure) in the ordinary
//      `bun test` run this repo's CI already does on every push (that job
//      never sets ANTHROPIC_API_KEY), and only actually executes in the
//      separate, path-filtered .github/workflows/extraction-eval.yml job
//      that injects the real secret. See eval/extraction/README.md for
//      the full reasoning and the CI wiring.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import { extractRules, ExtractionError } from "../../../src/prebrain/extraction/index.js";
import type { ExtractedRule, PrebrainChunk } from "../../../src/prebrain/extraction/index.js";
import { loadCorpus, runExtractionQuality, type BucketReport, type CorpusDocument, type ExtractedRuleLike } from "../../../eval/extraction/harness.js";

const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "eval", "extraction");

// Absolute tolerance per metric, not exact equality -- same reasoning as
// test_retrieval_eval.py and privacy-gate's eval-gate.test.ts: a rerun
// against unchanged code and an unchanged model should reproduce numbers
// close to the recorded baseline, but a live model call isn't bit-for-bit
// deterministic run to run, so a hard floor beats exact equality.
const TOLERANCE = 0.05;
const METRICS = ["recall", "precision"] as const;

interface Baseline {
  totalDocuments: number;
  overall: BucketReport;
  byCategory: BucketReport[];
}

function loadCorpusFile(): CorpusDocument[] {
  return loadCorpus(readFileSync(join(EVAL_DIR, "corpus.jsonl"), "utf8"));
}

function loadBaseline(): Baseline {
  const path = join(EVAL_DIR, "baseline.json");
  if (!existsSync(path)) {
    // No committed baseline yet -- this repo shipped this eval without a
    // real ANTHROPIC_API_KEY available to generate one (see README.md's
    // "No recorded cloud baseline yet" section). Fail with the exact next
    // step rather than a bare ENOENT, since this branch only runs once a
    // human has already added the secret that makes generating one
    // possible.
    throw new Error(
      `${path} does not exist yet. Generate it once with ` +
        '`bun run eval:extraction -- --mode cloud --write-baseline` from apps/cli, then commit ' +
        "the resulting eval/extraction/baseline.json.",
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as Baseline;
}

test("eval corpus covers both policy and no_policy documents with a real corpus, not a token gesture", () => {
  const docs = loadCorpusFile();
  expect(docs.length).toBeGreaterThanOrEqual(30);
  expect(new Set(docs.map((d) => d.category))).toEqual(new Set(["policy", "no_policy"]));
  const totalExpected = docs.reduce((sum, d) => sum + d.expected.length, 0);
  expect(totalExpected).toBeGreaterThanOrEqual(20);
  // Every no_policy document is a true negative fixture -- it must not
  // itself carry expected policies, or precision would have nothing
  // meaningful to fail against for that bucket.
  for (const doc of docs.filter((d) => d.category === "no_policy")) {
    expect(doc.expected).toHaveLength(0);
  }
});

async function extractForDocument(doc: CorpusDocument): Promise<ExtractedRuleLike[]> {
  const chunk: PrebrainChunk = {
    text: doc.text,
    sourcePath: doc.sourcePath,
    startLine: 1,
    endLine: doc.text.split("\n").length,
    walker: doc.walker as PrebrainChunk["walker"],
    looksLikeDecisionProse: "medium",
  };
  try {
    const rules = await extractRules([chunk], { mode: "cloud" });
    return rules.map((rule: ExtractedRule) => ({ title: rule.title, body: rule.body }));
  } catch (err) {
    if (err instanceof ExtractionError) {
      // Logged, not swallowed: a chunk-level failure here silently
      // becomes "0 rules found" for that document if nothing surfaces
      // the reason, which makes a systemic failure (a bad key, a rate
      // limit, a real SDK/schema break) indistinguishable in CI output
      // from the model genuinely finding nothing. This never affects the
      // score itself -- partialRules is still what gets returned.
      console.error(`extraction failed for ${doc.id}: ${err.message}`);
      return err.partialRules.map((rule) => ({ title: rule.title, body: rule.body }));
    }
    throw err;
  }
}

test.skipIf(!process.env.ANTHROPIC_API_KEY)(
  "extraction quality (cloud mode, claude-haiku-4-5) meets the recorded baseline",
  async () => {
    // 46 real, concurrent Anthropic calls -- bun's 5000ms test default is
    // tuned for local/mocked work and isn't enough headroom for a live
    // network run at this size. Bumped from 60s once the corpus grew past
    // 38 documents (four more connector fixtures added) and started
    // occasionally timing out at that ceiling in CI.
    const docs = loadCorpusFile();
    const baseline = loadBaseline();

    const report = await runExtractionQuality(docs, extractForDocument);

    const failures: string[] = [];

    function checkBucket(current: BucketReport, recorded: BucketReport | undefined, label: string) {
      if (!recorded) return; // a newly added bucket has no recorded floor yet
      for (const metric of METRICS) {
        const got = current[metric];
        const floor = recorded[metric] - TOLERANCE;
        if (got < floor) {
          failures.push(`${label}.${metric}: got ${got.toFixed(3)}, floor ${floor.toFixed(3)} (recorded baseline ${recorded[metric].toFixed(3)})`);
        }
      }
    }

    checkBucket(report.overall, baseline.overall, "overall");

    const baselineByCategory = new Map(baseline.byCategory.map((b) => [b.name, b]));
    for (const bucket of report.byCategory) checkBucket(bucket, baselineByCategory.get(bucket.name), bucket.name);

    expect(failures, "extraction quality regressed below the recorded baseline:\n" + failures.join("\n")).toHaveLength(0);
  },
  120_000,
);

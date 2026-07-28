#!/usr/bin/env bun
// The thing that actually runs eval/extraction/corpus.jsonl through the
// real extraction step (cloud.ts calling Anthropic's API, or local.ts
// calling a local Ollama daemon) and scores it -- mirrors the split
// between harness.ts (pure scoring) and run.ts/store_harness.py (the
// thing that talks to something real) in the other two evals this repo
// already has.
//
// Unlike either precedent, this makes REAL calls every time it runs --
// cloud mode is a real, paid Anthropic API call per document; local mode
// is a real call to whatever Ollama daemon --ollama-host points at. There
// is no fixed "correct" model output to precompute and replay the way an
// embedding vector or a deterministic gate output can be, so this script
// is deliberately not part of the always-on CI suite -- see
// eval/extraction/README.md for how cloud mode is wired into CI as a
// separate, path-filtered, secret-gated job instead.
//
// Usage:
//   bun run eval/extraction/run.ts --mode cloud                    # print the report
//   bun run eval/extraction/run.ts --mode cloud --write-baseline   # also write baseline.json
//   bun run eval/extraction/run.ts --mode local                    # against your own Ollama daemon
//   bun run eval/extraction/run.ts --mode local --ollama-model llama3.1:8b --write-baseline

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractRules, ExtractionError } from "../../src/prebrain/extraction/index.js";
import type { ExtractedRule, ExtractionOptions, PrebrainChunk } from "../../src/prebrain/extraction/index.js";
import { loadCorpus, reportToBaseline, runExtractionQuality } from "./harness.js";
import type { BucketReport, CorpusDocument, ExtractedRuleLike } from "./harness.js";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));

function loadCorpusFile(): CorpusDocument[] {
  const jsonl = readFileSync(join(EVAL_DIR, "corpus.jsonl"), "utf8");
  return loadCorpus(jsonl);
}

function formatBucket(bucket: BucketReport): string {
  const recallPct = (bucket.recall * 100).toFixed(1).padStart(5);
  const precisionPct = (bucket.precision * 100).toFixed(1).padStart(5);
  return (
    `${bucket.name.padEnd(12)} recall=${recallPct}% (${bucket.expectedFound}/${bucket.expectedTotal})  ` +
    `precision=${precisionPct}% (${bucket.extractedTruePositive}/${bucket.extractedTotal})`
  );
}

function docToChunk(doc: CorpusDocument): PrebrainChunk {
  return {
    text: doc.text,
    sourcePath: doc.sourcePath,
    startLine: 1,
    endLine: doc.text.split("\n").length,
    // The corpus only uses walker names extractRules actually branches
    // nothing on (walker only ever ends up in a rule's source citation),
    // so a cast here is safe -- see PrebrainWalker in
    // apps/cli/src/prebrain/types.ts for the full union this corpus draws
    // its "repo-scan" / "docs-dir" / "notion-export" values from.
    walker: doc.walker as PrebrainChunk["walker"],
    looksLikeDecisionProse: "medium",
  };
}

function toRuleLike(rule: ExtractedRule): ExtractedRuleLike {
  return { title: rule.title, body: rule.body };
}

// Runs extraction for one document at a time through the real
// extractRules entry point (not the lower-level cloud.ts/local.ts
// functions directly) -- this is the exact code path `gnt prebrain` runs
// per chunk, so the eval measures what customers actually get. One
// document per call, rather than batching the whole corpus into a single
// extractRules call, keeps the eval's per-document accounting exact
// without needing to regroup results afterward (several corpus documents
// deliberately reuse the same realistic sourcePath, e.g. "README.md",
// the way real walker output does).
async function extractForDocument(doc: CorpusDocument, options: ExtractionOptions): Promise<ExtractedRuleLike[]> {
  const chunk = docToChunk(doc);
  try {
    const rules = await extractRules([chunk], options);
    return rules.map(toRuleLike);
  } catch (err) {
    if (err instanceof ExtractionError) {
      // Surfaced, not swallowed: a chunk-level failure (auth, billing,
      // rate limit) must never look identical to "the model found no
      // rules here" in the report below -- that's exactly what let a
      // 100%-403 run get misread as a 0% recall model quality problem.
      console.error(`  [${doc.id}] extraction failed: ${err.chunkErrors.join("; ")}`);
      // A single-chunk call either fully succeeds or fully fails, so
      // partialRules is normally empty here -- but honor it anyway
      // rather than assuming, in case extractRules' partial-success
      // contract changes later.
      return err.partialRules.map(toRuleLike);
    }
    throw err;
  }
}

interface Cli {
  mode: "cloud" | "local";
  writeBaseline: boolean;
  noZdr: boolean;
  ollamaHost?: string;
  ollamaModel?: string;
}

function parseArgs(argv: string[]): Cli {
  let mode: "cloud" | "local" = "cloud";
  let writeBaseline = false;
  // See ExtractionOptions.requireZdr's own doc comment (types.ts) for why
  // this flag exists at all and why it's confined to this eval script:
  // ZDR is Pro/Enterprise-only on Vercel's AI Gateway, so a Hobby-plan
  // gateway key 403s on every call with it forced on. This corpus is
  // synthetic and repo-committed, never real customer text, so opting
  // this one script out of ZDR doesn't touch the real product's guarantee.
  let noZdr = false;
  let ollamaHost: string | undefined;
  let ollamaModel: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--write-baseline") writeBaseline = true;
    else if (arg === "--no-zdr") noZdr = true;
    else if (arg === "--mode") {
      const value = argv[++i];
      if (value !== "cloud" && value !== "local") {
        throw new Error(`--mode must be "cloud" or "local", got ${JSON.stringify(value)}`);
      }
      mode = value;
    } else if (arg?.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (value !== "cloud" && value !== "local") {
        throw new Error(`--mode must be "cloud" or "local", got ${JSON.stringify(value)}`);
      }
      mode = value;
    } else if (arg === "--ollama-host") ollamaHost = argv[++i];
    else if (arg?.startsWith("--ollama-host=")) ollamaHost = arg.slice("--ollama-host=".length);
    else if (arg === "--ollama-model") ollamaModel = argv[++i];
    else if (arg?.startsWith("--ollama-model=")) ollamaModel = arg.slice("--ollama-model=".length);
  }

  return { mode, writeBaseline, noZdr, ollamaHost, ollamaModel };
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const docs = loadCorpusFile();

  const options: ExtractionOptions =
    cli.mode === "cloud"
      ? { mode: "cloud", requireZdr: !cli.noZdr }
      : { mode: "local", ollamaHost: cli.ollamaHost, ollamaModel: cli.ollamaModel };

  console.log(
    `running ${docs.length} documents through the real ${cli.mode} extraction path` +
      (cli.mode === "local" ? ` (${cli.ollamaModel ?? "llama3.1:8b (default)"} @ ${cli.ollamaHost ?? "http://localhost:11434 (default)"})` : "") +
      "...\n",
  );

  const report = await runExtractionQuality(docs, (doc) => extractForDocument(doc, options));

  console.log(formatBucket(report.overall));
  console.log("\nby category:");
  for (const bucket of report.byCategory) console.log("  " + formatBucket(bucket));

  const missedDocs = report.documentResults.filter((r) => r.missedExpected.length > 0);
  if (missedDocs.length > 0) {
    console.log(`\n${missedDocs.length} document(s) with at least one missed policy:`);
    for (const result of missedDocs) {
      console.log(`  ${result.id} [${result.category}]: missed ${result.missedExpected.map((p) => p.id).join(", ")}`);
    }
  }

  const falsePositiveDocs = report.documentResults.filter((r) => r.falsePositiveRules.length > 0);
  if (falsePositiveDocs.length > 0) {
    console.log(`\n${falsePositiveDocs.length} document(s) with at least one hallucinated (unmatched) rule:`);
    for (const result of falsePositiveDocs) {
      console.log(`  ${result.id} [${result.category}]: ${result.falsePositiveRules.map((r) => JSON.stringify(r.title)).join(", ")}`);
    }
  }

  if (cli.writeBaseline) {
    const baseline = reportToBaseline(report) as Record<string, unknown>;
    baseline.mode = cli.mode;
    const path = cli.mode === "cloud" ? join(EVAL_DIR, "baseline.json") : join(EVAL_DIR, "baseline.local.json");
    writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`\nwrote ${path}`);
  }
}

main();

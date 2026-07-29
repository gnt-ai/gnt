// Extraction quality harness.
//
// Mirrors the shape of apps/api/eval/rule_retrieval/harness.py and
// apps/cli/eval/privacy-gate/harness.ts: pure scoring, no knowledge of how
// a result was produced. This module never calls extractRules itself --
// see run.ts for the thing that actually runs the corpus through the real
// cloud or local extraction path. That split means the scoring math here
// is directly unit-testable against synthetic fixtures (see
// test/prebrain/extraction/eval-harness.test.ts), independent of model
// behavior drifting for unrelated reasons.
//
// Unlike the privacy gate (100% local, deterministic) and unlike the
// retrieval eval (a fixed corpus replayed through committed embeddings),
// extraction quality can only be measured by actually calling the model
// being evaluated -- there's no way to precompute/commit a fixed "correct"
// model output the way an embedding vector can be. run.ts makes real,
// paid calls when it runs against cloud mode; see eval/extraction/README.md
// for the CI wiring that keeps that cost-gated rather than on every push.

export type EvalCategory = "policy" | "no_policy";

// The distinguishing fact(s) an expected policy hinges on -- a number,
// threshold, or named term a good extraction should carry through even
// after the model rephrases the rest of the sentence. Kept short and
// literal on purpose: a human skimming corpus.jsonl next to a model's
// extracted rule should be able to eyeball whether a match is fair,
// the same way the retrieval eval's exact-slug matching is legible by
// inspection rather than a fuzzy score nobody can sanity-check.
export interface ExpectedPolicy {
  id: string;
  keyTerms: string[];
  description?: string;
}

// One seeded source document, shaped like what a prebrain walker actually
// chunks (see apps/cli/src/prebrain/types.ts's PrebrainChunk) -- a single
// paragraph/section, with the walker and source path a real chunk would
// carry. `expected` is empty for `no_policy` documents on purpose: a good
// extraction pass over marketing copy, a changelog, or status notes should
// find nothing there, and an eval with only policy-bearing fixtures has
// nothing for precision to fail against.
export interface CorpusDocument {
  id: string;
  category: EvalCategory;
  walker: string;
  sourcePath: string;
  text: string;
  expected: ExpectedPolicy[];
}

// The subset of ExtractedRule/ExtractedRuleCandidate the scorer actually
// needs -- kept narrow so a synthetic test can construct one by hand
// without pulling in the real extraction module or a full schema.
export interface ExtractedRuleLike {
  title: string;
  body: string;
}

export interface DocumentResult {
  id: string;
  category: EvalCategory;
  matchedExpected: ExpectedPolicy[];
  missedExpected: ExpectedPolicy[];
  truePositiveRules: ExtractedRuleLike[];
  falsePositiveRules: ExtractedRuleLike[];
}

// A rule counts as matching an expected policy when every one of that
// policy's keyTerms shows up as a case-insensitive substring somewhere in
// the rule's title + body. Deliberately a cheap, deterministic heuristic
// over a second LLM-as-judge call -- a judge call would double the cost of
// every run and add its own noise to what's supposed to be a stable
// regression gate. This is the same spirit as the retrieval eval's exact
// slug matching, just against a looser fixture shape (a few distinguishing
// words/numbers instead of one exact id).
export function matchesPolicy(rule: ExtractedRuleLike, policy: ExpectedPolicy): boolean {
  const haystack = `${rule.title} ${rule.body}`.toLowerCase();
  return policy.keyTerms.every((term) => haystack.includes(term.toLowerCase()));
}

// Scores one document's real extraction output against its expected
// policies. A policy counts as found if ANY extracted rule matches it
// (recall doesn't care how many rules matched, just whether it was
// found); an extracted rule counts as a true positive if it matches ANY
// expected policy for that document (precision doesn't double-penalize a
// rule that happens to satisfy two expected policies' key terms at once).
export function scoreDocument(doc: CorpusDocument, extracted: ExtractedRuleLike[]): DocumentResult {
  const matchedExpected = doc.expected.filter((policy) => extracted.some((rule) => matchesPolicy(rule, policy)));
  const missedExpected = doc.expected.filter((policy) => !matchedExpected.includes(policy));

  const truePositiveRules = extracted.filter((rule) => doc.expected.some((policy) => matchesPolicy(rule, policy)));
  const falsePositiveRules = extracted.filter((rule) => !truePositiveRules.includes(rule));

  return { id: doc.id, category: doc.category, matchedExpected, missedExpected, truePositiveRules, falsePositiveRules };
}

export interface BucketReport {
  name: string;
  expectedTotal: number;
  expectedFound: number;
  recall: number;
  extractedTotal: number;
  extractedTruePositive: number;
  precision: number;
}

function buildBucket(name: string, results: DocumentResult[]): BucketReport {
  const expectedTotal = results.reduce((sum, r) => sum + r.matchedExpected.length + r.missedExpected.length, 0);
  const expectedFound = results.reduce((sum, r) => sum + r.matchedExpected.length, 0);
  const extractedTotal = results.reduce((sum, r) => sum + r.truePositiveRules.length + r.falsePositiveRules.length, 0);
  const extractedTruePositive = results.reduce((sum, r) => sum + r.truePositiveRules.length, 0);
  return {
    name,
    expectedTotal,
    expectedFound,
    // Vacuously 1 when a bucket has no expected policies at all (the
    // no_policy category) -- same reasoning as the privacy-gate harness's
    // buildBucket: there's nothing to have missed, so recall isn't the
    // meaningful number for that bucket. Precision is, on the same bucket
    // -- any extracted rule there is by definition a false positive
    // (hallucination), since no_policy documents have zero expected
    // policies for a true positive to match against.
    recall: expectedTotal === 0 ? 1 : expectedFound / expectedTotal,
    extractedTotal,
    extractedTruePositive,
    precision: extractedTotal === 0 ? 1 : extractedTruePositive / extractedTotal,
  };
}

function aggregateByCategory(results: DocumentResult[]): BucketReport[] {
  const byCategory = new Map<EvalCategory, DocumentResult[]>();
  for (const result of results) {
    const bucket = byCategory.get(result.category) ?? [];
    bucket.push(result);
    byCategory.set(result.category, bucket);
  }
  return [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, items]) => buildBucket(category, items));
}

export interface QualityReport {
  totalDocuments: number;
  overall: BucketReport;
  byCategory: BucketReport[];
  documentResults: DocumentResult[];
}

export type ExtractFn = (doc: CorpusDocument) => Promise<ExtractedRuleLike[]>;

// Runs every document through `extractFn` and scores it. An extractFn
// failure scores as a total miss (no rules extracted) rather than
// aborting the whole run -- one chunk that failed extraction (a
// schema-violating response, a network error) shouldn't hide the numbers
// for the rest of the corpus, same reasoning as
// run_retrieval_quality/runPrivacyGateQuality.
export async function runExtractionQuality(docs: CorpusDocument[], extractFn: ExtractFn): Promise<QualityReport> {
  const documentResults: DocumentResult[] = [];
  for (const doc of docs) {
    let extracted: ExtractedRuleLike[];
    try {
      extracted = await extractFn(doc);
    } catch {
      extracted = [];
    }
    documentResults.push(scoreDocument(doc, extracted));
  }

  return {
    totalDocuments: documentResults.length,
    overall: buildBucket("overall", documentResults),
    byCategory: aggregateByCategory(documentResults),
    documentResults,
  };
}

export function loadCorpus(jsonlText: string): CorpusDocument[] {
  return jsonlText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CorpusDocument);
}

// Serializes the metrics that matter for baseline.json -- per-document
// detail stays out of the committed baseline (it's regenerable from the
// corpus + a run) so a corpus edit doesn't produce a noisy diff full of
// per-document bookkeeping, same as reportToBaseline in the privacy-gate
// harness.
export function reportToBaseline(report: QualityReport): object {
  const strip = ({ name, expectedTotal, expectedFound, recall, extractedTotal, extractedTruePositive, precision }: BucketReport) => ({
    name,
    expectedTotal,
    expectedFound,
    recall,
    extractedTotal,
    extractedTruePositive,
    precision,
  });
  return {
    totalDocuments: report.totalDocuments,
    overall: strip(report.overall),
    byCategory: report.byCategory.map(strip),
  };
}

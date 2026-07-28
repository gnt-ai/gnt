// Unit tests for eval/extraction/harness.ts -- the pure scoring math,
// exercised against synthetic CorpusDocument/ExtractedRuleLike fixtures.
// Nothing here imports extractRules, calls a model, or reads corpus.jsonl:
// that's deliberate, mirroring the split in apps/api/eval/rule_retrieval
// and apps/cli/eval/privacy-gate (harness tests are pure and free; the
// real-corpus/real-model run is a separate, cost-gated concern -- see
// eval-gate.test.ts for the corpus-shape sanity check and the live gate).
import { expect, test } from "bun:test";
import {
  loadCorpus,
  matchesPolicy,
  reportToBaseline,
  runExtractionQuality,
  scoreDocument,
  type CorpusDocument,
  type ExtractedRuleLike,
} from "../../../eval/extraction/harness.js";

// -- matchesPolicy --

test("matchesPolicy: true when every keyTerm appears in the rule's title+body, case-insensitively", () => {
  const rule: ExtractedRuleLike = { title: "Refund window", body: "Full refund within 30 days of purchase." };
  expect(matchesPolicy(rule, { id: "p1", keyTerms: ["30 day", "refund"] })).toBe(true);
  expect(matchesPolicy(rule, { id: "p1", keyTerms: ["30 DAY", "REFUND"] })).toBe(true);
});

test("matchesPolicy: false when any keyTerm is missing", () => {
  const rule: ExtractedRuleLike = { title: "Refund window", body: "Full refund within 30 days of purchase." };
  expect(matchesPolicy(rule, { id: "p1", keyTerms: ["30 day", "chargeback"] })).toBe(false);
});

test("matchesPolicy: a keyTerm can be satisfied by the title alone", () => {
  const rule: ExtractedRuleLike = { title: "SEV1 pages on-call", body: "Page immediately on detection." };
  expect(matchesPolicy(rule, { id: "p1", keyTerms: ["sev1"] })).toBe(true);
});

// -- scoreDocument --

test("scoreDocument: an expected policy matched by any extracted rule counts as found", () => {
  const doc: CorpusDocument = {
    id: "d1",
    category: "policy",
    walker: "docs-dir",
    sourcePath: "handbook/refunds.md",
    text: "irrelevant for this test",
    expected: [{ id: "refund-30", keyTerms: ["30 day", "refund"] }],
  };
  const extracted: ExtractedRuleLike[] = [
    { title: "Unrelated rule", body: "something about MFA" },
    { title: "Refund window", body: "customers get a refund within 30 days" },
  ];
  const result = scoreDocument(doc, extracted);
  expect(result.matchedExpected).toHaveLength(1);
  expect(result.missedExpected).toHaveLength(0);
});

test("scoreDocument: an expected policy with no matching extracted rule counts as missed", () => {
  const doc: CorpusDocument = {
    id: "d2",
    category: "policy",
    walker: "docs-dir",
    sourcePath: "handbook/refunds.md",
    text: "irrelevant",
    expected: [{ id: "refund-30", keyTerms: ["30 day", "refund"] }],
  };
  const result = scoreDocument(doc, []);
  expect(result.matchedExpected).toHaveLength(0);
  expect(result.missedExpected).toEqual(doc.expected);
});

test("scoreDocument: an extracted rule that matches no expected policy counts as a false positive", () => {
  const doc: CorpusDocument = {
    id: "d3",
    category: "no_policy",
    walker: "repo-scan",
    sourcePath: "README.md",
    text: "marketing copy",
    expected: [],
  };
  const extracted: ExtractedRuleLike[] = [{ title: "Hallucinated rule", body: "made up policy about widgets" }];
  const result = scoreDocument(doc, extracted);
  expect(result.truePositiveRules).toHaveLength(0);
  expect(result.falsePositiveRules).toEqual(extracted);
});

test("scoreDocument: a rule that satisfies two expected policies at once still counts once as a true positive", () => {
  const doc: CorpusDocument = {
    id: "d4",
    category: "policy",
    walker: "docs-dir",
    sourcePath: "handbook/sla.md",
    text: "irrelevant",
    expected: [
      { id: "sla-4h", keyTerms: ["4 hour"] },
      { id: "sla-support", keyTerms: ["support"] },
    ],
  };
  const extracted: ExtractedRuleLike[] = [{ title: "Support SLA", body: "support tickets get a 4 hour response" }];
  const result = scoreDocument(doc, extracted);
  expect(result.matchedExpected).toHaveLength(2);
  expect(result.truePositiveRules).toHaveLength(1);
  expect(result.falsePositiveRules).toHaveLength(0);
});

// -- runExtractionQuality / aggregation --

test("runExtractionQuality: aggregates recall and precision correctly across categories", async () => {
  const docs: CorpusDocument[] = [
    { id: "a", category: "policy", walker: "docs-dir", sourcePath: "a.md", text: "x", expected: [{ id: "p1", keyTerms: ["alpha"] }] },
    { id: "b", category: "policy", walker: "docs-dir", sourcePath: "b.md", text: "y", expected: [{ id: "p2", keyTerms: ["beta"] }] },
    { id: "c", category: "no_policy", walker: "repo-scan", sourcePath: "c.md", text: "z", expected: [] },
  ];
  const report = await runExtractionQuality(docs, async (doc) => {
    if (doc.id === "a") return [{ title: "Alpha rule", body: "policy about alpha" }];
    if (doc.id === "b") return []; // missed
    return [{ title: "Hallucinated", body: "not a real policy" }]; // false positive on a no_policy doc
  });

  expect(report.totalDocuments).toBe(3);
  expect(report.overall.recall).toBeCloseTo(1 / 2);
  expect(report.overall.precision).toBeCloseTo(1 / 2);

  const policyBucket = report.byCategory.find((b) => b.name === "policy");
  expect(policyBucket?.recall).toBeCloseTo(1 / 2);
  const noPolicyBucket = report.byCategory.find((b) => b.name === "no_policy");
  // no_policy has zero expected policies -- recall is vacuously 1, but
  // precision reflects the one hallucinated rule directly.
  expect(noPolicyBucket?.recall).toBe(1);
  expect(noPolicyBucket?.precision).toBe(0);
});

test("runExtractionQuality: a bucket with no expected policies and no extracted rules reports recall 1 and precision 1, not NaN", async () => {
  const docs: CorpusDocument[] = [
    { id: "a", category: "no_policy", walker: "repo-scan", sourcePath: "a.md", text: "marketing", expected: [] },
  ];
  const report = await runExtractionQuality(docs, async () => []);
  expect(report.overall.recall).toBe(1);
  expect(report.overall.precision).toBe(1);
  expect(report.overall.expectedTotal).toBe(0);
  expect(report.overall.extractedTotal).toBe(0);
});

test("runExtractionQuality: an extractFn that throws scores the document as a total miss, not an aborted run", async () => {
  const docs: CorpusDocument[] = [
    { id: "a", category: "policy", walker: "docs-dir", sourcePath: "a.md", text: "x", expected: [{ id: "p1", keyTerms: ["alpha"] }] },
    { id: "b", category: "policy", walker: "docs-dir", sourcePath: "b.md", text: "y", expected: [{ id: "p2", keyTerms: ["beta"] }] },
  ];
  const report = await runExtractionQuality(docs, async (doc) => {
    if (doc.id === "a") throw new Error("boom");
    return [{ title: "Beta rule", body: "policy about beta" }];
  });
  expect(report.totalDocuments).toBe(2);
  expect(report.overall.expectedFound).toBe(1);
  expect(report.documentResults.find((r) => r.id === "a")?.missedExpected).toHaveLength(1);
});

// -- loadCorpus / reportToBaseline --

test("loadCorpus: parses JSONL, skipping blank lines", () => {
  const jsonl = [
    '{"id": "a", "category": "no_policy", "walker": "repo-scan", "sourcePath": "a.md", "text": "hi", "expected": []}',
    "",
    '{"id": "b", "category": "policy", "walker": "docs-dir", "sourcePath": "b.md", "text": "bye", "expected": [{"id": "p1", "keyTerms": ["x"]}]}',
    "   ",
  ].join("\n");
  const docs = loadCorpus(jsonl);
  expect(docs).toHaveLength(2);
  expect(docs[0]?.id).toBe("a");
  expect(docs[1]?.expected).toHaveLength(1);
});

test("reportToBaseline: strips per-document detail down to the bucket metrics", async () => {
  const docs: CorpusDocument[] = [
    { id: "a", category: "policy", walker: "docs-dir", sourcePath: "a.md", text: "x", expected: [{ id: "p1", keyTerms: ["alpha"] }] },
  ];
  const report = await runExtractionQuality(docs, async () => [{ title: "Alpha rule", body: "policy about alpha" }]);
  const baseline = reportToBaseline(report) as Record<string, unknown>;
  expect(baseline.totalDocuments).toBe(1);
  expect(baseline).not.toHaveProperty("documentResults");
  expect((baseline.overall as { recall: number }).recall).toBe(1);
});

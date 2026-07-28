// Unit tests for eval/privacy-gate/harness.ts -- the pure scoring math,
// exercised against synthetic CorpusCase/GateOutcome fixtures. Nothing
// here imports applyPrivacyGate or reads corpus.jsonl: that's deliberate,
// mirroring the split in apps/api/eval/rule_retrieval (harness.py is
// tested independently of store_harness.py). See
// test/privacy-gate/eval-gate.test.ts for the test that runs the real
// corpus through the real gate.
import { expect, test } from "bun:test";
import {
  loadCorpus,
  reportToBaseline,
  runPrivacyGateQuality,
  scoreCase,
  type CorpusCase,
  type GateOutcome,
} from "../../eval/privacy-gate/harness.js";
import type { DetectionHit } from "../../src/privacy-gate/types.js";

function hit(value: string, layer: DetectionHit["layer"] = "deterministic"): DetectionHit {
  return { placeholder: "[KEY_1]", kind: "KEY", layer, value, start: 0, end: value.length };
}

// -- scoreCase --

test("scoreCase: every shouldMask value found in hits counts as matched", () => {
  const kase: CorpusCase = {
    id: "c1",
    category: "secrets_in_prose",
    text: "the key is sk-abc and the ip is 1.2.3.4",
    shouldMask: [
      { value: "sk-abc", layer: "deterministic" },
      { value: "1.2.3.4", layer: "deterministic" },
    ],
  };
  const outcome: GateOutcome = { maskedText: "the key is [KEY_1] and the ip is [IP_1]", hits: [hit("sk-abc"), hit("1.2.3.4")] };
  const result = scoreCase(kase, outcome);
  expect(result.matched).toHaveLength(2);
  expect(result.missed).toHaveLength(0);
});

test("scoreCase: a shouldMask value with no matching hit counts as missed", () => {
  const kase: CorpusCase = {
    id: "c2",
    category: "contextual",
    text: "the person who filed the ticket",
    shouldMask: [{ value: "the person who filed the ticket", layer: "contextual" }],
  };
  const outcome: GateOutcome = { maskedText: kase.text, hits: [] };
  const result = scoreCase(kase, outcome);
  expect(result.matched).toHaveLength(0);
  expect(result.missed).toEqual(kase.shouldMask);
});

test("scoreCase: a shouldKeep value that survives untouched counts as keptOk", () => {
  const kase: CorpusCase = {
    id: "c3",
    category: "policy_vs_pii",
    text: "orders over $50 ship free",
    shouldMask: [],
    shouldKeep: ["$50"],
  };
  const outcome: GateOutcome = { maskedText: "orders over $50 ship free", hits: [] };
  const result = scoreCase(kase, outcome);
  expect(result.keptOk).toEqual(["$50"]);
  expect(result.overMasked).toHaveLength(0);
});

test("scoreCase: a shouldKeep value the gate masked anyway counts as overMasked", () => {
  const kase: CorpusCase = {
    id: "c4",
    category: "policy_vs_pii",
    text: "orders over $50 ship free",
    shouldMask: [],
    shouldKeep: ["$50"],
  };
  const outcome: GateOutcome = { maskedText: "orders over [AMOUNT_1] ship free", hits: [hit("$50", "amounts")] };
  const result = scoreCase(kase, outcome);
  expect(result.keptOk).toHaveLength(0);
  expect(result.overMasked).toEqual(["$50"]);
});

test("scoreCase: a shouldKeep value missing from the output with no matching hit still counts as overMasked", () => {
  // Covers the case where a span got swallowed by a larger, unrelated
  // match rather than masked as its own hit -- see the real
  // "SLA mistagged as ORG" case this corpus documents for why this
  // fallback check matters, not just the exact-hit-value check.
  const kase: CorpusCase = {
    id: "c5",
    category: "secrets_in_prose",
    text: "id ABC-123 filed",
    shouldMask: [],
    shouldKeep: ["ABC-123"],
  };
  const outcome: GateOutcome = { maskedText: "id [ORG_1]23 filed", hits: [hit("ABC-1", "ner")] };
  const result = scoreCase(kase, outcome);
  expect(result.overMasked).toEqual(["ABC-123"]);
});

// -- runPrivacyGateQuality / aggregation --

test("runPrivacyGateQuality: aggregates recall correctly across categories", async () => {
  const cases: CorpusCase[] = [
    { id: "a", category: "secrets_in_prose", text: "x", shouldMask: [{ value: "x", layer: "deterministic" }] },
    { id: "b", category: "secrets_in_prose", text: "y", shouldMask: [{ value: "y", layer: "deterministic" }] },
    { id: "c", category: "contextual", text: "z", shouldMask: [{ value: "z", layer: "contextual" }] },
  ];
  const report = await runPrivacyGateQuality(cases, async (text) => {
    if (text === "z") return { maskedText: text, hits: [] }; // layer 3 no-op
    return { maskedText: "[KEY_1]", hits: [hit(text)] };
  });

  expect(report.totalCases).toBe(3);
  expect(report.overall.recall).toBeCloseTo(2 / 3);

  const secrets = report.byCategory.find((b) => b.name === "secrets_in_prose");
  expect(secrets?.recall).toBe(1);
  const contextual = report.byCategory.find((b) => b.name === "contextual");
  expect(contextual?.recall).toBe(0);

  const deterministic = report.byLayer.find((b) => b.name === "deterministic");
  expect(deterministic?.recall).toBe(1);
  const contextualLayer = report.byLayer.find((b) => b.name === "contextual");
  expect(contextualLayer?.recall).toBe(0);
});

test("runPrivacyGateQuality: a bucket with no shouldMask entries reports recall 1 (vacuously true), not NaN", async () => {
  const cases: CorpusCase[] = [
    { id: "a", category: "policy_vs_pii", text: "orders over $50 ship free", shouldMask: [], shouldKeep: ["$50"] },
  ];
  const report = await runPrivacyGateQuality(cases, async (text) => ({ maskedText: text, hits: [] }));
  expect(report.overall.recall).toBe(1);
  expect(report.overall.maskTotal).toBe(0);
});

test("runPrivacyGateQuality: a gateFn that throws scores the case as a total miss, not an aborted run", async () => {
  const cases: CorpusCase[] = [
    { id: "a", category: "secrets_in_prose", text: "x", shouldMask: [{ value: "x", layer: "deterministic" }] },
    { id: "b", category: "secrets_in_prose", text: "y", shouldMask: [{ value: "y", layer: "deterministic" }] },
  ];
  const report = await runPrivacyGateQuality(cases, async (text) => {
    if (text === "x") throw new Error("boom");
    return { maskedText: "[KEY_1]", hits: [hit(text)] };
  });
  expect(report.totalCases).toBe(2);
  expect(report.overall.maskFound).toBe(1);
  expect(report.caseResults.find((r) => r.id === "a")?.missed).toHaveLength(1);
});

// -- loadCorpus / reportToBaseline --

test("loadCorpus: parses JSONL, skipping blank lines", () => {
  const jsonl = [
    '{"id": "a", "category": "contextual", "text": "hi", "shouldMask": []}',
    "",
    '{"id": "b", "category": "policy_vs_pii", "text": "bye", "shouldMask": [], "shouldKeep": ["bye"]}',
    "   ",
  ].join("\n");
  const cases = loadCorpus(jsonl);
  expect(cases).toHaveLength(2);
  expect(cases[0]?.id).toBe("a");
  expect(cases[1]?.shouldKeep).toEqual(["bye"]);
});

test("reportToBaseline: strips case-level detail down to the bucket metrics", async () => {
  const cases: CorpusCase[] = [
    { id: "a", category: "secrets_in_prose", text: "x", shouldMask: [{ value: "x", layer: "deterministic" }] },
  ];
  const report = await runPrivacyGateQuality(cases, async (text) => ({ maskedText: "[KEY_1]", hits: [hit(text)] }));
  const baseline = reportToBaseline(report) as Record<string, unknown>;
  expect(baseline.totalCases).toBe(1);
  expect(baseline).not.toHaveProperty("caseResults");
  expect((baseline.overall as { recall: number }).recall).toBe(1);
});

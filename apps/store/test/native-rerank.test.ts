import { describe, expect, test } from "bun:test";
import { applyReranker, RerankError, type RerankFn } from "../src/native/rerank.ts";

/** Pure applyReranker coverage — no DB, no network. Mirrors the vendored
 * engine's own rerank call-site contract: reorder the scored head,
 * preserve the un-reranked tail, fail open on any transport error. */
describe("applyReranker", () => {
  function candidate(chunkText: string, score: number): {
    chunkText: string;
    title: string;
    score: number;
    rerankScore?: number;
  } {
    return { chunkText, title: chunkText, score };
  }

  test("reorders the head by a deterministic fake reranker's scores", async () => {
    const results = [candidate("low relevance doc", 0.5), candidate("high relevance doc", 0.4)];
    // Real transports (the live API and the fixture replay) both return
    // results sorted by relevanceScore descending — applyReranker trusts
    // that contract rather than re-sorting itself, so the fake must too.
    const fake: RerankFn = async ({ documents }) =>
      documents
        .map((doc, index) => ({ index, relevanceScore: doc === "high relevance doc" ? 0.99 : 0.1 }))
        .sort((a, b) => b.relevanceScore - a.relevanceScore);

    const out = await applyReranker(
      "query",
      results,
      { enabled: true, topNIn: 25, topNOut: null, timeoutMs: 5000 },
      fake,
    );

    expect(out[0]?.chunkText).toBe("high relevance doc");
    expect(out[0]?.rerankScore).toBe(0.99);
    // RRF/cosine score is untouched by reranking — only rerankScore changes.
    expect(out[0]?.score).toBe(0.4);
  });

  test("preserves the un-reranked tail past topNIn in its original order", async () => {
    const results = [candidate("a", 0.9), candidate("b", 0.8), candidate("c", 0.7)];
    const fake: RerankFn = async ({ documents }) =>
      documents
        .map((_, index) => ({ index, relevanceScore: index }))
        .sort((a, b) => b.relevanceScore - a.relevanceScore);

    const out = await applyReranker(
      "query",
      results,
      { enabled: true, topNIn: 2, topNOut: null, timeoutMs: 5000 },
      fake,
    );

    expect(out.map((r) => r.chunkText)).toEqual(["b", "a", "c"]);
  });

  test("fails open to the original order on a transport error", async () => {
    const results = [candidate("a", 0.9), candidate("b", 0.8)];
    const throwing: RerankFn = async () => {
      throw new RerankError("boom", "network");
    };

    const out = await applyReranker(
      "query",
      results,
      { enabled: true, topNIn: 25, topNOut: null, timeoutMs: 5000 },
      throwing,
    );

    expect(out).toEqual(results);
  });

  test("disabled or empty input is a pure pass-through — never calls the transport", async () => {
    const results = [candidate("a", 0.9)];
    let called = false;
    const spy: RerankFn = async (input) => {
      called = true;
      return input.documents.map((_, index) => ({ index, relevanceScore: 1 }));
    };

    const disabled = await applyReranker(
      "query",
      results,
      { enabled: false, topNIn: 25, topNOut: null },
      spy,
    );
    expect(disabled).toEqual(results);
    expect(called).toBe(false);

    const empty = await applyReranker("query", [], { enabled: true, topNIn: 25, topNOut: null }, spy);
    expect(empty).toEqual([]);
    expect(called).toBe(false);
  });
});

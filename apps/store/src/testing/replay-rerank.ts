/**
 * Committed-fixture replay for the native rerank stage's eval run —
 * apps/store/scripts/eval-serve.ts only. Reads
 * apps/api/eval/rule_retrieval/fixtures/rerank.json, recorded once against
 * the live provider by makeRecordRerank below (see
 * apps/api/eval/rule_retrieval/record_rerank_fixture.py, the by-hand
 * driver).
 *
 * A miss here does NOT throw — this store's RRF/dedup pipeline can
 * legitimately assemble a different top-N candidate set on a later run
 * than the one that recorded this fixture (a corpus/query edit, a ranking
 * tweak), so a miss just means "no recorded score for this candidate," not
 * a fixture-drift bug. Missing candidates are simply omitted from the
 * returned scores; applyReranker's own tail-preserving fail-open logic
 * keeps them in their original fused-rank position.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { zeroEntropyRerank, type RerankFn, type RerankResultItem } from "../native/rerank.ts";

type RerankFixture = Record<string, Record<string, number>>;

export function makeReplayRerank(fixturePath: string): RerankFn {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as RerankFixture;

  return async ({ query, documents }) => {
    const scores = fixture[query];
    if (!scores) return [];
    const results: RerankResultItem[] = [];
    documents.forEach((doc, index) => {
      const score = scores[doc];
      if (score !== undefined) results.push({ index, relevanceScore: score });
    });
    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return results;
  };
}

/**
 * One-time recorder — issues the REAL rerank call (zeroEntropyRerank),
 * captures every (query, document) -> score into `fixturePath`, and
 * returns the live result untouched so the eval run measures true
 * reranked numbers while it records. Rewrites the whole fixture (sorted
 * keys) after every call so a killed run still leaves a complete file for
 * the queries it reached. Only reached when GNT_STORE_EVAL_RERANK_RECORD
 * is explicitly set (see eval-serve.ts) — never in a CI loop.
 */
export function makeRecordRerank(fixturePath: string): RerankFn {
  let fixture: RerankFixture = {};
  try {
    fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as RerankFixture;
  } catch {
    // First recording (or a stale/absent file) — start clean.
    fixture = {};
  }

  return async (input) => {
    const results = await zeroEntropyRerank(input);
    const scores: Record<string, number> = fixture[input.query] ?? {};
    for (const r of results) {
      const doc = input.documents[r.index];
      if (doc !== undefined) scores[doc] = r.relevanceScore;
    }
    fixture[input.query] = scores;
    const sorted = Object.fromEntries(Object.entries(fixture).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(fixturePath, JSON.stringify(sorted, null, 2) + "\n");
    return results;
  };
}

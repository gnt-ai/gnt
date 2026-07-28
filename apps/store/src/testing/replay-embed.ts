/**
 * Zero-compute, zero-cost embedding for the CI-gating retrieval eval
 * (apps/api/tests/test_retrieval_eval.py) — looks a precomputed vector up
 * by exact input text from a committed fixture instead of calling any
 * embedding function, real or fake. This is the actual point of caching
 * embeddings in apps/api/eval/rule_retrieval/fixtures/embeddings.json:
 * the fixture is generated once (offline, via
 * scripts/eval-generate-embeddings.ts) and every CI run afterward just
 * replays it, so the gate never spends money or time recomputing anything.
 *
 * Throws on a miss rather than falling back to some other embedding —
 * a silent fallback would mean the eval is quietly scoring against
 * different vectors than the ones the recorded baseline was measured
 * against, defeating the point of pinning the fixture at all.
 */
import { readFileSync } from "node:fs";

export function makeReplayEmbed(fixturePath: string): (text: string) => Promise<Float32Array> {
  const raw = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, number[]>;

  return async function replayEmbed(text: string): Promise<Float32Array> {
    const vec = raw[text];
    if (!vec) {
      throw new Error(
        `replayEmbed: no precomputed vector for text (len=${text.length}, starts "${text.slice(0, 60)}"). ` +
          "Regenerate apps/api/eval/rule_retrieval/fixtures/embeddings.json with " +
          "scripts/eval-generate-embeddings.ts if the corpus or queries changed.",
      );
    }
    return Float32Array.from(vec);
  };
}

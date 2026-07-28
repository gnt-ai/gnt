/**
 * Deterministic, GENUINELY SEMANTIC (unlike fake-embed.ts) embedding —
 * exists only because building apps/api/eval/rule_retrieval's baseline
 * needed some real signal to score against and this environment has no
 * ZEROENTROPY_API_KEY to call a real provider with.
 *
 * This is a hashing-trick bag-of-words embedding (unigrams + bigrams,
 * log-TF weighted, feature-hashed into DIM buckets with a random sign per
 * bucket, L2-normalized) — the same family of technique as scikit-learn's
 * HashingVectorizer or Vowpal Wabbit. It is real and lexical-overlap-based
 * (shared vocabulary between a query and a rule pulls cosine similarity
 * up), which is a meaningfully different failure mode from fake-embed.ts's
 * pure per-character hash (which carries no similarity signal at all,
 * useful only for exercising status/tenant filtering, never ranking
 * quality). It is NOT a neural embedding and has no notion of synonymy —
 * true paraphrase with disjoint vocabulary from the target rule will score
 * worse here than a real embedding model would. See
 * apps/api/eval/rule_retrieval/README.md for the full reasoning and how to
 * swap this out once real provider credentials are available.
 *
 * Used only offline, by scripts/eval-generate-embeddings.ts, to produce
 * the committed apps/api/eval/rule_retrieval/fixtures/embeddings.json —
 * never called at eval-test time (see replay-embed.ts, which is what the
 * CI-gating test actually runs against).
 */
const DIM = 1280; // matches content_chunks.embedding's vector(1280) column width

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

// FNV-1a — fast, well-distributed, no external dependency.
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export async function hashedEmbed(text: string): Promise<Float32Array> {
  const tokens = tokenize(text);
  const grams: string[] = [...tokens];
  for (let i = 0; i < tokens.length - 1; i++) grams.push(`${tokens[i]}_${tokens[i + 1]}`);

  const buckets = new Map<number, number>(); // bucket -> signed count
  for (const gram of grams) {
    const h = hash32(gram);
    const bucket = h % DIM;
    const sign = h & 1 ? 1 : -1;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + sign);
  }

  const out = new Float32Array(DIM);
  for (const [bucket, signedCount] of buckets) {
    const sign = signedCount < 0 ? -1 : 1;
    out[bucket] = sign * Math.log1p(Math.abs(signedCount));
  }

  let normSq = 0;
  for (let i = 0; i < DIM; i++) normSq += out[i] * out[i];
  const norm = Math.sqrt(normSq) || 1;
  for (let i = 0; i < DIM; i++) out[i] /= norm;
  return out;
}

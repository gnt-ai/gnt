/**
 * Offline, one-time generator for
 * apps/api/eval/rule_retrieval/fixtures/embeddings.json — the committed
 * fixture the CI-gating retrieval eval replays (see
 * ../src/testing/replay-embed.ts). Run this again only when the corpus or
 * query set changes, then re-run
 * `apps/api/eval/rule_retrieval/generate_baseline.py` to refresh the
 * recorded baseline against the new vectors.
 *
 * Defaults to hashedEmbed (src/testing/hashed-embed.ts) — a real,
 * deterministic, lexical embedding, useful for testing search plumbing
 * without a paid API call. Pass --provider=real to use the real production
 * embedding transport instead (requires ZEROENTROPY_API_KEY in the
 * environment) — that's what generated the committed baseline, and
 * produces vectors that actually test production's embedding quality. See
 * apps/api/eval/rule_retrieval/README.md.
 *
 * Usage: bun run scripts/eval-generate-embeddings.ts [--provider=hashed|real]
 */
import { join } from "node:path";
import { hashedEmbed } from "../src/testing/hashed-embed.ts";

const EVAL_DIR = join(import.meta.dir, "..", "..", "api", "eval", "rule_retrieval");

interface CorpusRule {
  id: string;
  title: string;
  body: string;
  tags: string[];
}

interface QueryCase {
  family: string;
  query: string;
  relevant: string[];
}

function parseJsonl<T>(text: string): T[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

async function resolveEmbedFn(): Promise<(text: string) => Promise<Float32Array>> {
  const provider = process.argv.find((a) => a.startsWith("--provider="))?.split("=")[1] ?? "hashed";
  if (provider === "hashed") return hashedEmbed;
  if (provider === "real") {
    const { zeroEntropyEmbed } = await import("../src/native/embed.ts");
    return zeroEntropyEmbed;
  }
  throw new Error(`unknown --provider "${provider}", expected "hashed" or "real"`);
}

async function main(): Promise<void> {
  const embed = await resolveEmbedFn();

  const corpus = parseJsonl<CorpusRule>(await Bun.file(join(EVAL_DIR, "corpus.jsonl")).text());
  const queries = parseJsonl<QueryCase>(await Bun.file(join(EVAL_DIR, "queries.jsonl")).text());

  // The exact string putPage embeds (see NativeStore#putPage in
  // ../src/native/store.ts) — must match byte-for-byte or replay-embed.ts
  // misses the fixture at seed time.
  const corpusTexts = corpus.map((rule) => `${rule.title}\n\n${rule.body}`);
  const queryTexts = queries.map((q) => q.query);
  const uniqueTexts = [...new Set([...corpusTexts, ...queryTexts])];

  const out: Record<string, number[]> = {};
  for (const text of uniqueTexts) {
    const vec = await embed(text);
    out[text] = Array.from(vec);
  }

  const outPath = join(EVAL_DIR, "fixtures", "embeddings.json");
  await Bun.write(outPath, JSON.stringify(out));
  console.log(
    JSON.stringify({
      event: "eval_embeddings_generated",
      texts: uniqueTexts.length,
      corpusRules: corpus.length,
      queries: queries.length,
      outPath,
    }),
  );
}

main();

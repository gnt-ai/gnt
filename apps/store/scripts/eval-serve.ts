/**
 * Boots the real apps/store internal HTTP API (same createFetchHandler as
 * production) backed by replayed embeddings/rerank scores instead of a
 * live provider — the CI-gating retrieval eval
 * (apps/api/tests/test_retrieval_eval.py) spawns this as a subprocess
 * exactly the way apps/api's own conftest.py spawns src/http/server.ts
 * for the rest of the pytest suite, just pointed at a different port and
 * different embed/rerank functions so the two never collide.
 *
 * NativeStore takes embedFn/rerankFn as plain constructor arguments, so
 * makeReplayEmbed/makeReplayRerank (../src/testing/) read the committed
 * fixtures directly rather than intercepting a gateway. NativeStore is
 * Postgres-only (see its own init() comment), so this needs a real
 * DATABASE_URL — GNT_STORE_EVAL_NATIVE_DATABASE_URL, falling back to the
 * same local test database the native test suite uses.
 *
 * Never used in production — see ../src/testing/replay-embed.ts and
 * ../src/testing/replay-rerank.ts, and apps/api/eval/rule_retrieval/README.md
 * for why a fixed, precomputed embedding fixture is the right thing here
 * (zero cost, zero flake, still exercises the real search code path end
 * to end).
 */
import { NativeStore } from "../src/native/store.ts";
import { createFetchHandler } from "../src/http/server.ts";
import { makeReplayEmbed } from "../src/testing/replay-embed.ts";
import { makeReplayRerank, makeRecordRerank } from "../src/testing/replay-rerank.ts";
import { fakeRerank } from "../src/testing/fake-rerank.ts";

async function main(): Promise<void> {
  const port = Number(process.env.GNT_STORE_PORT ?? 8787);
  const bind = process.env.GNT_STORE_BIND ?? "127.0.0.1";
  const secret = process.env.GNT_STORE_INTERNAL_API_SECRET;
  const fixturePath = process.env.GNT_STORE_EVAL_EMBEDDINGS_FIXTURE;
  const rerankRecordPath = process.env.GNT_STORE_EVAL_RERANK_RECORD;
  const rerankFixturePath = process.env.GNT_STORE_EVAL_RERANK_FIXTURE;

  if (!secret) {
    throw new Error("GNT_STORE_INTERNAL_API_SECRET is not set.");
  }
  if (!fixturePath) {
    throw new Error("GNT_STORE_EVAL_EMBEDDINGS_FIXTURE is not set — point it at embeddings.json.");
  }

  process.env.DATABASE_URL =
    process.env.GNT_STORE_EVAL_NATIVE_DATABASE_URL ?? "postgres://localhost:5432/gnt_store_native_test";

  // Record wins over replay (the one-time capture run points at both;
  // recording is what it's there to do). Otherwise replay the committed
  // fixture, or fall back to the safe no-op fake when there's no fixture
  // recorded yet for this query set.
  const rerankFn = rerankRecordPath
    ? makeRecordRerank(rerankRecordPath)
    : rerankFixturePath
      ? makeReplayRerank(rerankFixturePath)
      : fakeRerank;
  if (rerankRecordPath) {
    console.log(JSON.stringify({ event: "eval_rerank_recording", path: rerankRecordPath }));
  }

  const store = new NativeStore(makeReplayEmbed(fixturePath), rerankFn);
  await store.init({ engine: "postgres", orgId: "__eval_bootstrap__" });

  const server = Bun.serve({ port, hostname: bind, fetch: createFetchHandler(store, secret) });
  console.log(
    JSON.stringify({ event: "eval_store_listening", port: server.port, hostname: bind, engine: "postgres" }),
  );
}

main();

"""One-time (or "whenever the corpus/queries change") recorder for
apps/api/eval/rule_retrieval/fixtures/rerank.json — the committed zerank-2
score fixture the CI-gating eval replays so it can exercise the shipped
hybrid+rerank path for free (see README.md's "Baseline provenance" and
apps/store/src/testing/replay-rerank.ts).

Unlike embeddings, rerank inputs (the query + its top-N RRF candidate
documents) only exist mid-pipeline, so this can't precompute offline the way
eval-generate-embeddings.ts does. Instead it runs the real seed+query eval
ONCE with the reranker pointed at the LIVE provider (GNT_STORE_EVAL_RERANK_
RECORD), and the record transport captures every (query, document) -> score
into the fixture as it goes. This is the one place in the eval that makes a
real paid rerank call — a deliberate, one-time recording, the same category
as `eval-generate-embeddings.ts --provider=real`, NOT a CI loop.

Prereqs: ZEROENTROPY_API_KEY set (apps/store/.env) and
fixtures/embeddings.json present. Run by hand:

    cd apps/api && uv run python eval/rule_retrieval/record_rerank_fixture.py

Then run generate_baseline.py to record baseline.json against the committed
fixture (replayed, no live call).
"""

import asyncio
import json
import os
import sys
from pathlib import Path

_EVAL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_EVAL_DIR))
sys.path.insert(0, str(_EVAL_DIR.parent.parent / "src"))

from harness import load_query_cases, overall, run_retrieval_quality  # noqa: E402
from store_harness import EvalStoreHarness  # noqa: E402

_RERANK_FIXTURE = _EVAL_DIR / "fixtures" / "rerank.json"


def _load_corpus() -> list[dict]:
    lines = (_EVAL_DIR / "corpus.jsonl").read_text().splitlines()
    return [json.loads(line) for line in lines if line.strip()]


async def main() -> None:
    if not (_EVAL_DIR / "fixtures" / "embeddings.json").exists():
        raise SystemExit(
            "fixtures/embeddings.json is missing — generate it first with "
            "`cd apps/store && bun run scripts/eval-generate-embeddings.ts --provider=real`"
        )

    # Tell store_harness to spawn the eval server in RECORD mode: the reranker
    # runs against the live provider and the record transport writes every
    # score into this file. store.ts's search() only turns the reranker on
    # because this env var is set (see its reranker `enabled` gate).
    os.environ["GNT_STORE_EVAL_RERANK_RECORD"] = str(_RERANK_FIXTURE)

    corpus = _load_corpus()
    cases = load_query_cases((_EVAL_DIR / "queries.jsonl").read_text())
    print(f"recording rerank scores: {len(corpus)} rules, {len(cases)} query cases (LIVE zerank-2)...")

    async with EvalStoreHarness(port=8799) as store:
        await store.seed_corpus(corpus)
        report = await run_retrieval_quality(cases, store.search)

    overall_report = overall(report)
    print(
        f"\nlive hybrid+rerank  n={overall_report.n}  hit@1={overall_report.hit_at_1:.3f}  "
        f"hit@3={overall_report.hit_at_3:.3f}  mrr={overall_report.mrr:.3f}  "
        f"recall@3={overall_report.recall_at_k:.3f}  recall@10={overall_report.recall_at_10:.3f}"
    )
    for family_report in report.families:
        print(
            f"{family_report.family:<14} n={family_report.n:<3} hit@1={family_report.hit_at_1:.3f}  "
            f"hit@3={family_report.hit_at_3:.3f}  mrr={family_report.mrr:.3f}  "
            f"recall@3={family_report.recall_at_k:.3f}  recall@10={family_report.recall_at_10:.3f}"
        )
    print(f"\nwrote {_RERANK_FIXTURE}")
    print("next: `uv run python eval/rule_retrieval/generate_baseline.py` to record baseline.json (replayed).")


if __name__ == "__main__":
    asyncio.run(main())

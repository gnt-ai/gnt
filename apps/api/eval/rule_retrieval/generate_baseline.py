"""One-time (or "whenever the corpus/queries change") runner that seeds
the real apps/store search path with this eval's corpus, runs every query
case through it, and records the resulting hit@1/hit@3/MRR/recall@k as
this eval's baseline.json — the number apps/api/tests/test_retrieval_eval.py
gates future runs against.

Not a pytest test and not collected by `uv run pytest` (testpaths is
["tests"], this lives in eval/) — run it by hand:

    cd apps/api && uv run python eval/rule_retrieval/generate_baseline.py

Prerequisite: apps/api/eval/rule_retrieval/fixtures/embeddings.json must
already exist (generate it with
`cd apps/store && bun run scripts/eval-generate-embeddings.ts`) — this
script replays those precomputed vectors, it never computes embeddings
itself. See README.md for why.
"""

import asyncio
import json
import sys
from pathlib import Path

_EVAL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_EVAL_DIR))
sys.path.insert(0, str(_EVAL_DIR.parent.parent / "src"))

from harness import load_query_cases, overall, report_to_dict, run_retrieval_quality  # noqa: E402
from store_harness import EvalStoreHarness  # noqa: E402


def _load_corpus() -> list[dict]:
    lines = (_EVAL_DIR / "corpus.jsonl").read_text().splitlines()
    return [json.loads(line) for line in lines if line.strip()]


async def main() -> None:
    if not (_EVAL_DIR / "fixtures" / "embeddings.json").exists():
        raise SystemExit(
            "fixtures/embeddings.json is missing — generate it first with "
            "`cd apps/store && bun run scripts/eval-generate-embeddings.ts`"
        )

    corpus = _load_corpus()
    cases = load_query_cases((_EVAL_DIR / "queries.jsonl").read_text())
    print(f"seeding {len(corpus)} rules, running {len(cases)} query cases...")

    async with EvalStoreHarness(port=8799) as store:
        await store.seed_corpus(corpus)
        report = await run_retrieval_quality(cases, store.search)

    result = report_to_dict(report)
    (_EVAL_DIR / "baseline.json").write_text(json.dumps(result, indent=2) + "\n")

    overall_report = overall(report)
    print(f"\noverall  n={overall_report.n}  hit@1={overall_report.hit_at_1:.3f}  "
          f"hit@3={overall_report.hit_at_3:.3f}  mrr={overall_report.mrr:.3f}  "
          f"recall@3={overall_report.recall_at_k:.3f}  recall@10={overall_report.recall_at_10:.3f}")
    for family_report in report.families:
        print(
            f"{family_report.family:<14} n={family_report.n:<3} hit@1={family_report.hit_at_1:.3f}  "
            f"hit@3={family_report.hit_at_3:.3f}  mrr={family_report.mrr:.3f}  "
            f"recall@3={family_report.recall_at_k:.3f}  recall@10={family_report.recall_at_10:.3f}"
        )
    print(f"\nwrote {_EVAL_DIR / 'baseline.json'}")


if __name__ == "__main__":
    asyncio.run(main())

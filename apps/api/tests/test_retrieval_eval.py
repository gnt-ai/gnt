"""CI gate for rule-retrieval quality regression.

Runs all 81 query cases in apps/api/eval/rule_retrieval/queries.jsonl
against a freshly seeded, real apps/store instance (real PGLite engine,
real pgvector cosine search, the exact HTTP path store_client.search_rules
calls — see eval/rule_retrieval/store_harness.py) and fails the build if
hit@1/hit@3/MRR/recall@k regress below the recorded baseline
(eval/rule_retrieval/baseline.json) by more than TOLERANCE.

Fast and free by design: the corpus, the queries, and their embeddings
are all fixed and precomputed (eval/rule_retrieval/fixtures/embeddings.json,
generated once by `apps/store/scripts/eval-generate-embeddings.ts` and
committed) — this test never calls a live embedding API, it replays the
committed vectors through the real search code path. The committed
vectors are real zembed-1 embeddings generated via ZeroEntropy's
production API. See apps/api/eval/rule_retrieval/README.md for the full
reasoning, including baseline provenance and how to regenerate everything
after a corpus or query change.
"""

import json
import sys
from pathlib import Path

_EVAL_DIR = Path(__file__).resolve().parents[1] / "eval" / "rule_retrieval"
sys.path.insert(0, str(_EVAL_DIR))

from harness import load_query_cases, overall, run_retrieval_quality  # noqa: E402
from store_harness import EvalStoreHarness  # noqa: E402

# Absolute tolerance per metric, not exact equality — the corpus, queries,
# and their embeddings are fixed and committed, so a rerun against
# unchanged code reproduces the exact baseline numbers; the floor buffer
# exists so a legitimate ranking-boundary change (a tie broken differently,
# a rounding difference) doesn't fail the build over noise.
TOLERANCE = 0.02

_METRICS = ("hit_at_1", "hit_at_3", "mrr", "recall_at_k", "recall_at_10")


def _load_corpus() -> list[dict]:
    lines = (_EVAL_DIR / "corpus.jsonl").read_text().splitlines()
    return [json.loads(line) for line in lines if line.strip()]


def _load_baseline() -> dict:
    return json.loads((_EVAL_DIR / "baseline.json").read_text())


def test_eval_corpus_covers_all_four_query_families():
    """Cheap sanity check independent of the store subprocess — the eval
    requires >= 50 cases spanning exact-name, paraphrase, keyword-only,
    and multi-rule. Catches a corpus edit that silently drops a family or
    shrinks below the floor, without needing to boot the store."""
    cases = load_query_cases((_EVAL_DIR / "queries.jsonl").read_text())
    assert len(cases) >= 50
    assert {c.family for c in cases} == {"exact_name", "paraphrase", "keyword_only", "multi_rule"}


async def test_rule_retrieval_quality_meets_baseline():
    corpus = _load_corpus()
    cases = load_query_cases((_EVAL_DIR / "queries.jsonl").read_text())
    baseline = _load_baseline()

    async with EvalStoreHarness(port=8799) as store:
        await store.seed_corpus(corpus)
        report = await run_retrieval_quality(cases, store.search)

    failures: list[str] = []

    current_overall = overall(report)
    baseline_overall = baseline["overall"]
    for metric in _METRICS:
        got = getattr(current_overall, metric)
        floor = baseline_overall[metric] - TOLERANCE
        if got < floor:
            failures.append(
                f"overall.{metric}: got {got:.3f}, floor {floor:.3f} "
                f"(recorded baseline {baseline_overall[metric]:.3f})"
            )

    baseline_by_family = {f["family"]: f for f in baseline["families"]}
    for family_report in report.families:
        baseline_family = baseline_by_family.get(family_report.family)
        if baseline_family is None:
            continue  # a newly added family has no recorded floor yet
        for metric in _METRICS:
            got = getattr(family_report, metric)
            floor = baseline_family[metric] - TOLERANCE
            if got < floor:
                failures.append(
                    f"{family_report.family}.{metric}: got {got:.3f}, floor {floor:.3f} "
                    f"(recorded baseline {baseline_family[metric]:.3f})"
                )

    assert not failures, "rule-retrieval quality regressed below the recorded baseline:\n" + "\n".join(
        failures
    )

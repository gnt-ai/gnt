"""Rule-retrieval quality harness. Scores hit@1, hit@3,
MRR, and recall@k against a corpus of query -> expected-rule-id cases,
grouped into four query families: exact_name,
paraphrase, keyword_only, multi_rule.

Pure and provider-agnostic: this module never calls a search API itself.
Callers inject an async `search_fn(query) -> ranked slug list`; see
store_harness.py for the thing that actually talks
to a running apps/store instance.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

K = 3


@dataclass(frozen=True)
class QueryCase:
    family: str
    query: str
    relevant: list[str]


@dataclass(frozen=True)
class QueryResult:
    family: str
    query: str
    hit_at_1: bool
    hit_at_3: bool
    reciprocal_rank: float
    recall_at_k: float
    recall_at_10: float


@dataclass(frozen=True)
class FamilyReport:
    family: str
    n: int
    hit_at_1: float
    hit_at_3: float
    mrr: float
    recall_at_k: float
    recall_at_10: float


@dataclass(frozen=True)
class RetrievalQualityReport:
    k: int
    total: int
    families: list[FamilyReport]
    questions: list[QueryResult]

    def family(self, name: str) -> FamilyReport | None:
        return next((f for f in self.families if f.family == name), None)


def _aggregate(family: str, items: list[QueryResult]) -> FamilyReport:
    n = len(items)
    return FamilyReport(
        family=family,
        n=n,
        hit_at_1=sum(i.hit_at_1 for i in items) / n if n else 0.0,
        hit_at_3=sum(i.hit_at_3 for i in items) / n if n else 0.0,
        mrr=sum(i.reciprocal_rank for i in items) / n if n else 0.0,
        recall_at_k=sum(i.recall_at_k for i in items) / n if n else 0.0,
        recall_at_10=sum(i.recall_at_10 for i in items) / n if n else 0.0,
    )


def score_query(case: QueryCase, ranked: list[str]) -> QueryResult:
    relevant = set(case.relevant)
    first_idx: int | None = next((i for i, slug in enumerate(ranked) if slug in relevant), None)
    hit1 = first_idx == 0
    hit3 = first_idx is not None and first_idx < K
    rr = 1.0 / (first_idx + 1) if first_idx is not None else 0.0

    def recall_at(k: int) -> float:
        if not relevant:
            return 0.0
        top = ranked[:k]
        found = sum(1 for slug in top if slug in relevant)
        return found / len(relevant)

    return QueryResult(
        family=case.family,
        query=case.query,
        hit_at_1=hit1,
        hit_at_3=hit3,
        reciprocal_rank=rr,
        recall_at_k=recall_at(K),
        recall_at_10=recall_at(10),
    )


SearchFn = Callable[[str], Awaitable[list[str]]]


async def run_retrieval_quality(cases: list[QueryCase], search_fn: SearchFn) -> RetrievalQualityReport:
    """Runs every case through search_fn and scores it. A search_fn failure
    scores as a total miss (empty ranked list) rather than aborting the
    whole run — one broken query shouldn't hide the scores for the other
    49+, and "the search call itself errored" is exactly the kind of
    regression this eval exists to catch."""
    results: list[QueryResult] = []
    for case in cases:
        try:
            ranked = await search_fn(case.query)
        except Exception:
            ranked = []
        results.append(score_query(case, ranked))

    by_family: dict[str, list[QueryResult]] = {}
    for result in results:
        by_family.setdefault(result.family, []).append(result)

    families = [_aggregate(family, items) for family, items in sorted(by_family.items())]
    return RetrievalQualityReport(k=K, total=len(results), families=families, questions=results)


def overall(report: RetrievalQualityReport) -> FamilyReport:
    """Aggregate across every family — the top-line number the CI gate
    checks in addition to (not instead of) the per-family breakdown."""
    return _aggregate("overall", report.questions)


def report_to_dict(report: RetrievalQualityReport) -> dict:
    return {
        "k": report.k,
        "total": report.total,
        "overall": vars(overall(report)),
        "families": [vars(f) for f in report.families],
    }


def load_query_cases(jsonl_text: str) -> list[QueryCase]:
    import json

    cases = []
    for line in jsonl_text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        obj = json.loads(stripped)
        cases.append(QueryCase(family=obj["family"], query=obj["query"], relevant=obj["relevant"]))
    return cases

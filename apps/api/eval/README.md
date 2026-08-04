# Eval suites

This directory holds **quality evals** for retrieval and extraction — measuring
how well the store finds the right rules against fixture or synthetic corpora.
These are not the unit/integration tests under `apps/api/tests/`; they answer
"does hybrid search still retrieve well at this scale?" rather than "does this
endpoint return 200?"

## Suites

| Suite | CI? | What it measures |
| --- | --- | --- |
| [`rule_retrieval/`](rule_retrieval/README.md) | Yes | Hit@k / MRR / recall for `search_rules` on a small, curated corpus (hybrid retrieval + reranker). |
| [`rule_retrieval_at_scale/`](rule_retrieval_at_scale/README.md) | No (research) | Whether vector-only accuracy degrades vs hybrid as a single-org corpus grows to 1K–1M rules. Runs on free local models only. |

Read each suite's own README for layout, how to run it, and how to interpret results.

## `refund_triage/`

Not present in the tree today. If you see an empty local leftover with that
name (e.g. from an old WIP), it is unused — safe to ignore or delete locally.
Do not treat it as a third eval suite.

# NativeStore cutover — done

`STORE_BACKEND` defaulted to (and now only supports) `native` as of the
removal of the third-party knowledge-store dependency this package used to
depend on. The `native` adapter (`src/native/`) owns its own schema, CRUD,
hybrid search, and git-native sync — see `src/native/store.ts`'s header
comment for the current shape and `src/native/search.ts` for the hybrid
retrieval pipeline.

One scope decision worth knowing if you're reading the ranking code:
`NativeStore`'s hybrid pipeline doesn't implement autocut (score-discontinuity
result-trimming) — a deliberate simplification, verified against the
retrieval eval (`apps/api/eval/rule_retrieval/`) rather than assumed safe.
Revisit only if a future eval run shows it regressing a metric.

The full pre-cutover runbook (preconditions, the flip, post-flip
verification, rollback plan) served its purpose and is gone — there's no
longer a second backend to roll back to.

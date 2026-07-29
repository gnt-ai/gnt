# Rule-retrieval at scale (scale re-open)

One-off **research** eval. Not wired into CI. Answers a single question the
two prior hybrid-retrieval investigations couldn't, because they topped out
at 47 rules:

> Does plain vector-only search's accuracy meaningfully degrade as a single
> enterprise customer's own rule corpus grows into the tens/hundreds of
> thousands (up to 1M) — in a way hybrid retrieval (vector + BM25 keyword +
> reciprocal-rank fusion, optionally + a reranker) measurably fixes?

Tenant isolation means only single-org corpus size matters — one search
never sees more than one org's rules — so the tiers here model one very
large customer, not gnt's platform-wide total.

**This eval spends zero paid API dollars.** No ZeroEntropy call, no paid
embedding, no paid reranker. Everything runs on free, locally-run,
open-source models. See "Cost" below.

## TL;DR result

All four tiers (1K / 10K / 100K / 1M) completed. The hybrid-over-vector-only
gap **widens with corpus size** and is largest at 1M, exactly where it
matters most:

| tier | vector_only hit@1 | hybrid hit@1 | hybrid+rerank hit@1 | Δ (rerank − vector) |
|---|---|---|---|---|
| 1,000 | 0.750 | 0.773 | 0.782 | +0.032 |
| 10,000 | 0.844 | 0.901 | 0.915 | +0.071 |
| 100,000 | 0.767 | 0.880 | 0.888 | +0.121 |
| 1,000,000 | 0.679 | 0.791 | 0.846 | **+0.167** |

On the **collision family** — the department-disambiguation stress test that
is the whole point of this eval — vector-only visibly degrades at the top of
the range (0.933 at 10K → 0.707 at 1M) while hybrid holds far more of its
accuracy (0.960 → 0.840, rerank 0.967 → 0.867). `keyword_only` shows the
widest gap of any family: vector-only falls from 0.847 (10K) to 0.573 (1M)
hit@1, hybrid+rerank stays at 0.873 — a 30-point gap at the top tier.

This is a real, meaningful architectural signal — not a green light to ship
hybrid outright. See "Honest recommendation" below.

## Why this is a separate directory, not the CI eval

The CI-gating eval (`apps/api/eval/rule_retrieval/`) is untouched. It runs
the real apps/store subprocess + real PGLite + real HTTP boundary at 47
rules — perfect for realism and regression-catching at that size, and it
still gates `search_rules`. That harness cannot practically reach 100K-1M
rows (PGLite WASM memory ceiling, HNSW build time, and a per-query HTTP
round-trip multiplied over hundreds of queries), which is the whole point of
this exercise. So this is a fresh, lighter-weight, in-process harness.

## Free models (zero paid API)

- **Embeddings: `sentence-transformers/all-MiniLM-L6-v2`** (384-dim, ~80MB).
  A genuine semantic model (unlike the existing repo's `hashed-embed.ts`
  bag-of-words stand-in, which has no notion of synonymy and was shown to
  systematically understate real vector quality — deliberately not used
  here). Small and fast enough to embed 1M short rules in minutes on CPU/MPS.
  Chosen because it is exactly the model the task suggested and it is the
  established default for cheap local semantic search. Its **absolute**
  quality is below production's ZeroEntropy `zembed-1` (1280-dim); that is
  expected and fine — this eval measures the **delta** between arms across
  scale, not production-accurate absolute accuracy.
- **Reranker: `cross-encoder/ms-marco-MiniLM-L-6-v2`** (free, local) as a
  stand-in for the paid `zerank-2`. The production reranker arm has no free
  replay seam — a cross-encoder call can't be replayed from a committed
  fixture the way a query embedding can — so the "with-reranker" arm is
  impossible to run for real under the zero-paid constraint. A smaller
  cross-encoder still answers the architectural question "does a rerank
  stage move the needle at scale."

The isolated harness uses the free model's real 384-dim output. It does NOT
pad/project to production's `vector(1280)` — that would distort cosine
similarity. This harness runs its own in-process math, not shared prod infra.

## The three arms (same code path per tier — apples-to-apples)

At every tier all three arms consume the **same** candidate pool and the
**same** scoring code:

1. **`vector_only`** — plain cosine kNN. This is the shipped `searchVector`
   path on `main`.
2. **`hybrid_no_rerank`** — the same hybrid ranking `native/search.ts` ships:
   RRF fusion of the vector list + a BM25 keyword list with `RRF_K = 60`
   (`score += 1/(60+rank)`), normalize by max, then a cosine re-score blend
   `0.7*normRrf + 0.3*cosine`. Graph signals off, cross-page dedup off —
   matching the production call exactly.
3. **`hybrid_rerank`** — arm 2, then a cross-encoder reranks the top-N.

### Faithful reimplementation, not the literal engine code — and why

The hybrid arm reproduces the engine's algorithm (constants pulled straight
from `hybrid.ts`: `RRF_K=60`, the `0.7/0.3` blend, per-list RRF), but it is
Python + numpy + `bm25s`, not the literal TypeScript `hybridSearch`. Two
reasons, both load-bearing:

1. The literal `hybridSearch` can't run over 100K-1M rows in PGLite (the
   memory/index/round-trip wall above) — the exact scale under test.
2. The reranker arm has no free path regardless (see above).

Simplifications, stated honestly:
- **Keyword arm is BM25** (via `bm25s`), where the engine uses Postgres
  `ts_rank(websearch_to_tsquery)`. Both are lexical TF-IDF-family scorers;
  BM25 is the standard, and this is a lexical-arm proxy, not the identical
  ranker.
- **Vector arm is exact brute-force cosine**, not approximate HNSW. This is
  *more* accurate than production's ANN index, so if anything it flatters
  vector-only (makes the hybrid win a conservative lower bound).
- **Intent weighting left at the default** (`general`: keyword=vector=1.0,
  exactMatchBoost=1.0, a no-op). `store.ts`'s `search()` passes no intent
  override and rule queries overwhelmingly classify `general`; modeling the
  full intent classifier was out of scope.

Verdict: this measures the vector-vs-hybrid **delta** validly (both arms
share pool + scoring); it is not a bit-exact replay of the production stack.

## Corpus design

One simulated large enterprise, 10 department clusters (finance, legal,
engineering, hr, sales, support, security, procurement, marketing,
operations). Each department has 3-5 authored policy **concepts** (expense
approval, wire transfer, incident escalation, data retention, PTO, refund,
access review, vendor onboarding, …), each written with several sentence
variants.

- **Hand-seeded cross-department collision groups** at every tier: the same
  policy concept living in 2-4 departments with genuinely different
  specifics — `refund` (finance/sales/support), `escalation`
  (engineering/hr/support/security/marketing/operations), `data_retention`
  (legal/engineering/security), `access_review` (hr/security/operations),
  `expense_approval` (finance/sales/procurement/marketing/operations),
  `vendor` (legal/sales/procurement), `onboarding` (hr/engineering/security),
  `privacy_request` (legal/marketing). These share the concept keyword (so
  BM25 alone is confused) and are disambiguated only by department + scope.
  This is the whole point of the test.
- **Uniquely-addressable scopes.** Every rule's scope is a globally-unique,
  high-cardinality natural-language tuple (`the {division} division of
  {team} ({segment}, FY{year}) in {region}`) drawn by a full-period LCG walk
  over a 2.85M-combo space. This matters: an early version collided titles
  (only ~216 team×region combos per concept) so at 100K the gold rule was
  buried among identical-titled siblings and **no** method could find it —
  that's an underspecified-query artifact, not a retrieval failure. Unique
  scopes make every rule findable, so difficulty comes from disambiguating
  among many *similar-but-distinct* policies — the realistic hard case.
- **Bounded multi-answer clusters** for the `multi_rule` family: a named
  cross-functional "program" spans 3-6 sibling rules; a query about the
  program should surface all of them. Bounded gold sets keep `recall@k`
  meaningful at every tier (an "all X policies" query's gold explodes to
  thousands of instances at 100K and makes recall meaningless).

At 1K the structure is dense and hand-shaped; above that the same authored
concepts are stamped out over the unique-scope space (parameterized, not
boilerplate — each rule is a distinct policy with distinct
threshold/window/role specifics).

## Query set (per tier, 5 families)

Same four families as the CI eval, plus a dedicated collision family:

- `exact_name` (150) — the rule's title verbatim.
- `paraphrase` (150) — same intent, disjoint vocabulary.
- `keyword_only` (150) — a keyword fragment + the rule's scope.
- `multi_rule` (60) — a named program; the whole bounded cluster is gold.
- `collision` (150) — names the concept + a department-disambiguating cue;
  only that department's rule is gold, though same-concept rules in other
  departments exist as distractors. **The point of the whole eval.**

## Layout / reproduce

```
generate_corpus.py   # corpus + queries for a tier (deterministic, seeded)
embed_corpus.py      # MiniLM embeddings (run ephemerally via uv --with)
run_eval.py          # three-arm harness -> results/<tier>_results.json
corpus/tier_{1k,10k,100k,1m}/   # corpus.jsonl, queries.jsonl, *.npy, *_ids.json
results/             # committed metric tables per tier
```

```bash
# generate (fast, pure python)
python generate_corpus.py --n 100000 --out corpus/tier_100k --queries-per-family 150

# embed + eval ephemerally — sentence-transformers/torch/bm25s never touch
# the committed dependency tree (no pyproject change).
export HF_HUB_DISABLE_IMPLICIT_TOKEN=1   # ignore any stale local HF oauth token
uv run --with sentence-transformers --with numpy --with torch \
    python embed_corpus.py --tier corpus/tier_100k
uv run --with sentence-transformers --with numpy --with torch --with bm25s \
    python run_eval.py --tier corpus/tier_100k --rerank
```

## Cost

Zero paid API calls. `all-MiniLM-L6-v2` and `ms-marco-MiniLM-L-6-v2` are
downloaded once from HuggingFace (public, free) and run locally on CPU/MPS.
No ZeroEntropy embedding or reranker call is ever made. `torch` /
`sentence-transformers` / `bm25s` are pulled ephemerally by `uv run --with`
and are NOT added to `apps/api/pyproject.toml` — this is a research tool, not
a product dependency.

## Full results

See `results/tier_{1k,10k,100k,1m}_results.json` for the complete per-family
tables (hit@1, hit@3, mrr, recall@3, recall@10) for all three arms at every
tier. `summarize.py` prints cross-tier markdown comparison tables (the
numbers above come from it). One family is worth flagging on its own:
`multi_rule` (bounded 3-6-rule program clusters) stays noisy and low across
every arm at every tier (n=60, small bounded gold sets against a limit-25
window) — reranking clearly helps it here (0.100→0.783 hit@3 at 1M,
vector-only vs hybrid+rerank), which is a **different** result from the
original 47-rule finding (reranker actively hurt multi_rule there).
That's not a direct contradiction — this eval uses bounded named-program
clusters, a free stand-in reranker, and a completely different corpus design
than the original "all X policies" multi_rule queries — but it means the
original reranker-hurts-multi_rule finding should NOT be assumed to hold at
scale without its own re-check.

## Honest recommendation

**Worth a small, cost-bounded confirmation run — not a green light to ship.**
The delta between vector-only and hybrid widens with scale in a way that
would matter for a "near-perfect accuracy" bar, and it shows up most on
exactly the query type (cross-department collisions) this investigation
exists to stress. But every number above comes from a smaller, weaker free
embedder (`all-MiniLM-L6-v2`, 384-dim) standing in for production's
`zembed-1` (1280-dim) — a weaker embedder plausibly degrades faster with
scale than the real model would, so the trend could be partly (or wholly) an
artifact of the stand-in rather than a real property of vector search at
scale. The right next step is a modest, paid confirmation run: same
methodology, same query families, a mid-size tier (10K-100K, not the full
1M) with the real `zembed-1` embeddings, to check whether the widening gap
survives with the production model. If it does, that is the founder's
signal to actually invest in shipping hybrid for large-corpus customers. If
it washes out with the real model, this was a stand-in artifact and
vector-only stays the right call at every scale tested.

## Practical scaling notes

- Embedding 1M rules with MiniLM on Apple MPS: a few minutes. Exact cosine
  over 1M×384 for 660 queries: seconds (chunked). BM25 index over 1M docs
  via `bm25s`: ~a minute. The rerank arm scales with query count (660×25
  pairs), not corpus size, so it stays ~seconds at every tier.
- The `.npy` embedding fixtures are committed per tier so `run_eval.py`
  reruns without re-embedding. The 1M `rule_emb.npy` is ~1.5GB; if that is
  too large to commit it is regenerable in minutes from `corpus.jsonl` via
  `embed_corpus.py` (the corpus + queries are the source of truth).

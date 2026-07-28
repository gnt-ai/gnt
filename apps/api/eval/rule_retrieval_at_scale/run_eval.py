"""Three-arm retrieval eval at scale. Vector-only vs hybrid(no rerank) vs
hybrid(rerank), all three going through the SAME candidate pool and the SAME
scoring code at each tier, so the comparison is apples-to-apples.

The hybrid arm is a faithful reimplementation of the production hybrid
algorithm (apps/store/src/native/search.ts), NOT the literal TypeScript
code path. Why a reimplementation:

  1. The literal engine hybridSearch cannot practically run over 100K-1M rows
     in PGLite (WASM memory ceiling + HNSW build time + per-query HTTP round
     trip), which is the entire scale this task exists to probe.
  2. The engine's reranker arm has NO free replay seam (the item-11 commit
     says so outright) — it is a paid ZeroEntropy cross-encoder. Running the
     literal "with-reranker" arm for real is impossible under the zero-paid-
     API constraint. So arm 3 needs a free local stand-in regardless.

What is reproduced exactly from hybrid.ts:
  - RRF fusion:  rrf = sum over lists of 1/(RRF_K + rank),  RRF_K = 60,
    rank 0-indexed, then normalize the fused scores by their max.
  - Cosine re-score blend:  blended = 0.7 * normRrf + 0.3 * cosine,
    sorted descending (hybrid.ts cosineReScore).
  - Vector-only arm = plain cosine kNN (the shipped searchVector path on main).
  - Same final limit (25) each arm; graph signals / cross-page dedup off,
    matching store.ts's eval-path call.
Intent weighting is left at the DEFAULT ('general': keyword=vector=1.0,
exactMatchBoost=1.0, a no-op) rather than modeling the full intent
classifier — the store's search() passes no intent override and the vast
majority of rule queries classify general; documented as a simplification.

Stand-ins (both free, both local, zero paid API calls):
  - embeddings: all-MiniLM-L6-v2 (384-dim), precomputed by embed_corpus.py.
  - reranker:   cross-encoder/ms-marco-MiniLM-L-6-v2, in place of the paid
    zerank-2. A smaller cross-encoder, but the ARCHITECTURAL question ("does
    a rerank stage move the needle at scale") is answerable with it.
"""

from __future__ import annotations

import argparse
import json
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

RRF_K = 60          # engine hybrid.ts RRF_K
BLEND_RRF = 0.7     # engine cosineReScore
BLEND_COS = 0.3
LIMIT = 25          # engine store.ts search() limit
CAND = 100          # per-arm candidate pool before fusion


def load_jsonl(p: Path):
    return [json.loads(line) for line in p.open()]


# ---- lexical (BM25) arm ----------------------------------------------------

def build_bm25(rule_texts):
    import bm25s
    tokens = bm25s.tokenize(rule_texts, stopwords="en", show_progress=False)
    r = bm25s.BM25()
    r.index(tokens, show_progress=False)
    return r


def bm25_topk(retriever, query_texts, k):
    import bm25s
    q_tokens = bm25s.tokenize(query_texts, stopwords="en", show_progress=False)
    idx, scores = retriever.retrieve(q_tokens, k=k, show_progress=False)
    return idx  # (Q, k) doc indices, best first


# ---- vector arm ------------------------------------------------------------

def vector_topk(query_emb, rule_emb, k):
    """Exact cosine kNN (embeddings are L2-normalized -> dot == cosine).
    Chunked over queries to bound memory at large corpus sizes."""
    Q = query_emb.shape[0]
    out_idx = np.empty((Q, k), dtype=np.int64)
    out_sim = np.empty((Q, k), dtype=np.float32)
    chunk = max(1, min(Q, 2_000_000 // max(1, rule_emb.shape[0]) + 1))
    for s in range(0, Q, chunk):
        e = min(Q, s + chunk)
        sims = query_emb[s:e] @ rule_emb.T           # (c, N)
        kk = min(k, sims.shape[1])
        part = np.argpartition(-sims, kk - 1, axis=1)[:, :kk]
        # sort the top-kk slice
        rows = np.arange(e - s)[:, None]
        order = np.argsort(-sims[rows, part], axis=1)
        top = part[rows, order]
        out_idx[s:e, :kk] = top
        out_sim[s:e, :kk] = sims[rows, order]
    return out_idx, out_sim


# ---- fusion ----------------------------------------------------------------

def rrf_hybrid(vec_idx_row, key_idx_row, query_vec, rule_emb):
    """Faithful RRF + cosine-rescore for ONE query.
    vec_idx_row/key_idx_row: ranked doc-index arrays (best first)."""
    score = defaultdict(float)
    for rank, d in enumerate(vec_idx_row):
        if d < 0:
            continue
        score[int(d)] += 1.0 / (RRF_K + rank)
    for rank, d in enumerate(key_idx_row):
        if d < 0:
            continue
        score[int(d)] += 1.0 / (RRF_K + rank)
    if not score:
        return []
    max_rrf = max(score.values())
    cand = list(score.keys())
    # cosine re-score blend over the fused candidate set
    cand_emb = rule_emb[cand]                       # (C, dim)
    cos = cand_emb @ query_vec                       # (C,) both normalized
    blended = []
    for i, d in enumerate(cand):
        norm_rrf = score[d] / max_rrf if max_rrf > 0 else 0.0
        blended.append((BLEND_RRF * norm_rrf + BLEND_COS * float(cos[i]), d))
    blended.sort(key=lambda t: -t[0])
    return [d for _, d in blended]


# ---- metrics ---------------------------------------------------------------

def score_query(ranked_ids, gold_set):
    gold = set(gold_set)
    top1, top3, top10 = ranked_ids[:1], ranked_ids[:3], ranked_ids[:10]
    hit1 = 1.0 if gold & set(top1) else 0.0
    hit3 = 1.0 if gold & set(top3) else 0.0
    mrr = 0.0
    for i, rid in enumerate(ranked_ids):
        if rid in gold:
            mrr = 1.0 / (i + 1)
            break
    rec3 = len(gold & set(top3)) / len(gold)
    rec10 = len(gold & set(top10)) / len(gold)
    return dict(hit1=hit1, hit3=hit3, mrr=mrr, recall3=rec3, recall10=rec10)


def aggregate(rows):
    keys = ["hit1", "hit3", "mrr", "recall3", "recall10"]
    out = {"n": len(rows)}
    for k in keys:
        out[k] = round(sum(r[k] for r in rows) / len(rows), 4) if rows else 0.0
    return out


def report(per_query, arm):
    by_fam = defaultdict(list)
    allr = []
    for q, m in per_query:
        by_fam[q["family"]].append(m)
        allr.append(m)
    res = {"overall": aggregate(allr)}
    for fam in sorted(by_fam):
        res[fam] = aggregate(by_fam[fam])
    return res


# ---- reranker arm ----------------------------------------------------------

def rerank(order_ids_per_query, queries, id_to_text, topn, model_name):
    """Cross-encoder rerank of each query's top-N hybrid candidates."""
    from sentence_transformers import CrossEncoder
    ce = CrossEncoder(model_name)
    out = []
    pairs = []
    spans = []
    for q, ranked in order_ids_per_query:
        head = ranked[:topn]
        spans.append((len(pairs), len(pairs) + len(head), head))
        pairs.extend([[q["query"], id_to_text[rid]] for rid in head])
    scores = ce.predict(pairs, batch_size=256, show_progress_bar=True) if pairs else []
    for (s, e, head), (q, ranked) in zip(spans, order_ids_per_query):
        sub = list(scores[s:e])
        reordered = [rid for _, rid in sorted(zip(sub, head), key=lambda t: -t[0])]
        out.append((q, reordered + ranked[topn:]))
    return out


# ---- main ------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--rerank", action="store_true", help="also run the cross-encoder rerank arm")
    ap.add_argument("--rerank-model", default="cross-encoder/ms-marco-MiniLM-L-6-v2")
    ap.add_argument("--rerank-topn", type=int, default=25)
    args = ap.parse_args()

    tier = Path(args.tier)
    rules = load_jsonl(tier / "corpus.jsonl")
    queries = load_jsonl(tier / "queries.jsonl")
    rule_emb = np.load(tier / "rule_emb.npy")
    query_emb = np.load(tier / "query_emb.npy")
    rule_ids = json.loads((tier / "rule_ids.json").read_text())
    assert [r["id"] for r in rules] == rule_ids, "corpus/emb id order drift"
    idx_to_id = rule_ids
    id_to_text = {r["id"]: f"{r['title']}\n{r['body']}" for r in rules}

    print(f"[{tier.name}] rules={len(rules)} queries={len(queries)} dim={rule_emb.shape[1]}")

    # candidate pools (shared by both hybrid + vector-only)
    t0 = time.time()
    vec_idx, _ = vector_topk(query_emb, rule_emb, CAND)
    t1 = time.time()
    retriever = build_bm25([f"{r['title']}\n{r['body']}" for r in rules])
    key_idx = bm25_topk(retriever, [q["query"] for q in queries], CAND)
    t2 = time.time()
    print(f"vector pool {t1-t0:.1f}s | bm25 index+pool {t2-t1:.1f}s")

    # ARM 1: vector-only (shipped main path)
    vec_per_query = []
    # ARM 2: hybrid no rerank
    hyb_order = []   # (query, ranked_ids) full order for rerank feed
    hyb_per_query = []
    for i, q in enumerate(queries):
        v_ranked_idx = [int(d) for d in vec_idx[i] if d >= 0]
        v_ranked_ids = [idx_to_id[d] for d in v_ranked_idx][:LIMIT]
        vec_per_query.append((q, score_query(v_ranked_ids, q["gold"])))

        fused_idx = rrf_hybrid(vec_idx[i], key_idx[i], query_emb[i], rule_emb)
        fused_ids = [idx_to_id[d] for d in fused_idx][:LIMIT]
        hyb_order.append((q, fused_ids))
        hyb_per_query.append((q, score_query(fused_ids, q["gold"])))

    results = {
        "vector_only": report(vec_per_query, "vector_only"),
        "hybrid_no_rerank": report(hyb_per_query, "hybrid_no_rerank"),
    }

    # ARM 3: hybrid + cross-encoder rerank (free local stand-in reranker)
    if args.rerank:
        t3 = time.time()
        reranked = rerank(hyb_order, queries, id_to_text, args.rerank_topn, args.rerank_model)
        rr_per_query = [(q, score_query(ids, q["gold"])) for q, ids in reranked]
        results["hybrid_rerank"] = report(rr_per_query, "hybrid_rerank")
        print(f"rerank arm {time.time()-t3:.1f}s")

    out = Path(args.out) if args.out else tier.parent.parent / "results" / f"{tier.name}_results.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "tier": tier.name,
        "n_rules": len(rules),
        "n_queries": len(queries),
        "embedding_model": "all-MiniLM-L6-v2 (384d, free/local)",
        "reranker": args.rerank_model + " (free/local stand-in)" if args.rerank else None,
        "results": results,
    }
    out.write_text(json.dumps(payload, indent=2))

    # pretty print
    for arm, res in results.items():
        print(f"\n=== {arm} ===")
        for fam, m in res.items():
            print(f"  {fam:16s} n={m['n']:<5d} hit@1={m['hit1']:.3f} hit@3={m['hit3']:.3f} "
                  f"mrr={m['mrr']:.3f} recall@3={m['recall3']:.3f} recall@10={m['recall10']:.3f}")
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()

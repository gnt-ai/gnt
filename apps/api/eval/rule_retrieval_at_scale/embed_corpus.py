"""Embed a tier's corpus + queries with a FREE, locally-run open-source
sentence embedding model. No paid API is ever called.

Model: sentence-transformers/all-MiniLM-L6-v2 (384-dim). Chosen because it
is a genuine semantic model (unlike the hashed bag-of-words stand-in the
existing eval deliberately avoids), it is tiny (~80MB) and CPU/MPS-fast
enough to embed 100K-1M short rules in minutes, and it is the exact model
the at-scale task suggested. Its ABSOLUTE quality is below the production
model (ZeroEntropy zembed-1, 1280-dim) — that is fine and expected: this
research eval measures the DELTA between vector-only and hybrid retrieval as
corpus size grows, not production-accurate absolute numbers. The delta is
what tells us whether hybrid would matter at scale.

Run ephemerally so torch/sentence-transformers never touch the committed
dependency tree:

    uv run --with sentence-transformers --with numpy \
        python embed_corpus.py --tier corpus/tier_1k
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"


def load_jsonl(p: Path):
    return [json.loads(line) for line in p.open()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", required=True, help="tier dir with corpus.jsonl / queries.jsonl")
    ap.add_argument("--batch", type=int, default=512)
    args = ap.parse_args()

    tier = Path(args.tier)
    rules = load_jsonl(tier / "corpus.jsonl")
    queries = load_jsonl(tier / "queries.jsonl")

    # Prefer Apple MPS, fall back to CPU. Either way, fully local.
    import torch
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"model={MODEL_NAME} device={device} rules={len(rules)} queries={len(queries)}")

    model = SentenceTransformer(MODEL_NAME, device=device)

    rule_texts = [f"{r['title']}\n{r['body']}" for r in rules]
    query_texts = [q["query"] for q in queries]

    t0 = time.time()
    rule_emb = model.encode(rule_texts, batch_size=args.batch, show_progress_bar=True,
                            normalize_embeddings=True, convert_to_numpy=True).astype(np.float32)
    t1 = time.time()
    query_emb = model.encode(query_texts, batch_size=args.batch, show_progress_bar=True,
                             normalize_embeddings=True, convert_to_numpy=True).astype(np.float32)
    t2 = time.time()

    np.save(tier / "rule_emb.npy", rule_emb)
    np.save(tier / "query_emb.npy", query_emb)
    # id order sidecars so the harness never relies on jsonl/npy row alignment drift
    (tier / "rule_ids.json").write_text(json.dumps([r["id"] for r in rules]))
    (tier / "query_ids.json").write_text(json.dumps([q["id"] for q in queries]))

    print(f"rule_emb {rule_emb.shape} in {t1-t0:.1f}s | query_emb {query_emb.shape} in {t2-t1:.1f}s")
    print(f"saved to {tier}")


if __name__ == "__main__":
    main()

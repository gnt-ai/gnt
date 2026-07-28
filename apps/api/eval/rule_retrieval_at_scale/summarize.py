"""Print cross-tier comparison tables from results/*.json (markdown)."""
import json
from pathlib import Path

TIERS = ["tier_1k", "tier_10k", "tier_100k", "tier_1m"]
ARMS = ["vector_only", "hybrid_no_rerank", "hybrid_rerank"]
RES = Path(__file__).parent / "results"


def load():
    out = {}
    for t in TIERS:
        p = RES / f"{t}_results.json"
        if p.exists():
            out[t] = json.loads(p.read_text())
    return out


def main():
    data = load()
    tiers = [t for t in TIERS if t in data]

    for metric in ["hit1", "hit3", "mrr"]:
        print(f"\n### overall {metric}\n")
        print("| tier | vector_only | hybrid | Δ hybrid | hybrid+rerank | Δ rerank |")
        print("|---|---|---|---|---|---|")
        for t in tiers:
            r = data[t]["results"]
            v = r["vector_only"]["overall"][metric]
            h = r["hybrid_no_rerank"]["overall"][metric]
            rr = r["hybrid_rerank"]["overall"][metric]
            n = data[t]["n_rules"]
            print(f"| {n:,} | {v:.3f} | {h:.3f} | {h-v:+.3f} | {rr:.3f} | {rr-v:+.3f} |")

    print("\n### collision family — hit@1 (the disambiguation test)\n")
    print("| tier | vector_only | hybrid | hybrid+rerank |")
    print("|---|---|---|---|")
    for t in tiers:
        r = data[t]["results"]
        v = r["vector_only"]["collision"]["hit1"]
        h = r["hybrid_no_rerank"]["collision"]["hit1"]
        rr = r["hybrid_rerank"]["collision"]["hit1"]
        print(f"| {data[t]['n_rules']:,} | {v:.3f} | {h:.3f} | {rr:.3f} |")

    for fam in ["exact_name", "paraphrase", "keyword_only", "multi_rule"]:
        print(f"\n### {fam} — hit@1 / hit@3\n")
        print("| tier | vec h@1 | hyb h@1 | rr h@1 | vec h@3 | hyb h@3 | rr h@3 |")
        print("|---|---|---|---|---|---|---|")
        for t in tiers:
            r = data[t]["results"]
            def g(arm, m): return r[arm][fam][m]
            print(f"| {data[t]['n_rules']:,} | {g('vector_only','hit1'):.3f} | {g('hybrid_no_rerank','hit1'):.3f} | "
                  f"{g('hybrid_rerank','hit1'):.3f} | {g('vector_only','hit3'):.3f} | "
                  f"{g('hybrid_no_rerank','hit3'):.3f} | {g('hybrid_rerank','hit3'):.3f} |")


if __name__ == "__main__":
    main()

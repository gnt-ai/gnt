"""Demo recording script: content_extraction drafting a rule from a raw
note, then rule_conflict catching that it contradicts an existing
approved rule -- before a human ever merges it.

Run from apps/api: `uv run python demo/conflict_demo.py`

Both gnt.pipeline.content_extraction.extract_candidate_rules and
gnt.pipeline.rule_conflict.judge_conflict are imported directly,
unmodified -- the real production functions, not mocks.
"""

from gnt.pipeline.content_extraction import extract_candidate_rules
from gnt.pipeline.rule_conflict import judge_conflict

# The org's real, already-approved rule (would be a previously merged PR).
EXISTING_RULE = {
    "title": "Standard refund policy",
    "body": "Full refunds are approved within 30 days of purchase, no questions asked.",
}

# Raw internal note -- the kind of thing that actually drives a new rule
# getting written today: a Slack message, a support macro, a policy memo.
RAW_NOTE = (
    "Hey team, quick heads up: per the call with finance this morning, we "
    "are no longer offering refunds under any circumstances, effective "
    "immediately. Please stop offering refunds if customers ask, no "
    "exceptions."
)


def main():
    print("=" * 70)
    print("STEP 1 -- content_extraction: drafting a rule from a raw note")
    print("(this is what happens today, with or without gnt.ai -- someone")
    print(" writes down what they read. Nothing has checked it yet.)")
    print("=" * 70)
    candidates, _in_tok, _out_tok = extract_candidate_rules("internal-note", RAW_NOTE)
    for c in candidates:
        print(f'  drafted rule: "{c.title}"')
        print(f"    body: {c.body}")
    if not candidates:
        print("  (no candidates extracted)")
        return
    new_rule = candidates[0]

    print("\n" + "=" * 70)
    print("WITHOUT gnt.ai: this draft just gets merged as-is.")
    print(f"Existing approved rule (\"{EXISTING_RULE['title']}\") says the opposite.")
    print("Nobody catches it until a customer gets two different answers.")
    print("=" * 70)

    print("\n" + "=" * 70)
    print("STEP 2 -- WITH gnt.ai: judge_conflict runs the moment it's proposed")
    print("=" * 70)
    verdict, _in_tok2, _out_tok2 = judge_conflict(
        EXISTING_RULE["title"], EXISTING_RULE["body"], new_rule.title, new_rule.body
    )
    print(f"  relation: {verdict.relation}")
    print(f"  explanation: {verdict.explanation}")
    print("\nThis is exactly what shows up in the pull request body -- the human")
    print("merging it sees the conflict flagged before they approve anything.")


if __name__ == "__main__":
    main()

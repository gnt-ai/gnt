"""Demo recording script: naive agent vs. the same agent with gnt.ai's
real check_action wired in as a tool.

Run from apps/api: `uv run python demo/check_action_demo.py`

Uses gnt.action_check.judge_action directly, unmodified -- the exact
function apps/api/src/gnt/action_check.py's evaluate_action calls in
production. Nothing about the gnt.ai side of this is mocked.
"""

import json

from gnt.action_check import judge_action
from gnt.anthropic_client import get_client

# The real approved rule -- this is what would live as a merged, human-
# reviewed file in the company's GitHub repo. Deliberately specific and a
# little counter-intuitive: a generic agent following "reasonable
# customer service" instincts would not guess this on its own.
REAL_RULE = {
    "slug": "rules/refund-annual-plans",
    "title": "Refunds on annual subscription plans",
    "body": (
        "Refund requests for annual subscription plans are only approved "
        "within 14 days of purchase, regardless of usage. After 14 days, "
        "annual-plan refund requests are never auto-approved or auto-denied "
        "by an agent -- they must always be escalated to a human on the "
        "billing team, even if the customer says they never used the product."
    ),
}

SCENARIO = (
    "A customer emails support: \"Hi, I signed up for the annual plan about "
    "six weeks ago but honestly forgot about it and never actually used the "
    "product. Can I get a refund?\" Decide what to do: approve the refund, "
    "deny it, or escalate to a human. Give your decision and a one or two "
    "sentence reason."
)

AGENT_SYSTEM = (
    "You are an AI support agent for a software company, handling billing "
    "requests on the company's behalf. You decide what action to take on "
    "each request."
)

CHECK_POLICY_TOOL = {
    "name": "check_company_policy",
    "description": (
        "Check the company's actual approved policy before acting on a billing "
        "or refund request. Returns a grounded verdict: allowed, blocked, or "
        "needs_human, citing the specific rule it's based on."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "action_description": {"type": "string", "description": "The action being considered."}
        },
        "required": ["action_description"],
    },
}


def run_naive(client):
    print("=" * 70)
    print("STEP 1 -- NAIVE AGENT (no gnt.ai, no company-specific context)")
    print("=" * 70)
    response = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=300,
        system=AGENT_SYSTEM,
        messages=[{"role": "user", "content": SCENARIO}],
    )
    text = "".join(b.text for b in response.content if b.type == "text")
    print(text)


def run_grounded(client):
    print("\n" + "=" * 70)
    print("STEP 2 -- SAME AGENT, WITH gnt.ai's check_action tool wired in")
    print("=" * 70)

    messages = [{"role": "user", "content": SCENARIO}]
    response = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=500,
        system=AGENT_SYSTEM
        + " Before deciding on a billing or refund action, you MUST call "
        "check_company_policy to check the real, approved company rule.",
        tools=[CHECK_POLICY_TOOL],
        messages=messages,
    )

    tool_use = next((b for b in response.content if b.type == "tool_use"), None)
    if tool_use is None:
        print("(agent didn't call the tool -- printing its direct answer instead)")
        print("".join(b.text for b in response.content if b.type == "text"))
        return

    action_description = tool_use.input["action_description"]
    print(f'[agent calls check_company_policy: "{action_description}"]')

    # REAL gnt.ai code, not a mock.
    judgment, _input_tokens, _output_tokens = judge_action(action_description, None, [REAL_RULE])
    print(
        f"[gnt.ai verdict: {judgment.verdict}  |  cites: {judgment.cited_rule_ids}  "
        f"|  reason: {judgment.reason}]"
    )

    messages.append({"role": "assistant", "content": response.content})
    messages.append(
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": tool_use.id,
                    "content": json.dumps(
                        {
                            "verdict": judgment.verdict,
                            "cited_rule_ids": judgment.cited_rule_ids,
                            "reason": judgment.reason,
                        }
                    ),
                }
            ],
        }
    )

    final = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=300,
        system=AGENT_SYSTEM,
        tools=[CHECK_POLICY_TOOL],
        messages=messages,
    )
    final_text = "".join(b.text for b in final.content if b.type == "text")
    print("\n[agent's final decision]")
    print(final_text)


if __name__ == "__main__":
    print(f"Real approved rule (would be a merged PR in production):\n  {REAL_RULE['title']}: {REAL_RULE['body']}\n")
    client = get_client()
    run_naive(client)
    run_grounded(client)

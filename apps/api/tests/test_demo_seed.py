import uuid

from demo.seed_compose import DEMO_DESCRIPTION, DEMO_RULE_ID, _curl, _demo_rule


def test_demo_rule_is_an_approved_store_rule_with_structured_provenance():
    rule = _demo_rule()

    assert uuid.UUID(DEMO_RULE_ID)
    assert rule["slug"] == f"rules/{DEMO_RULE_ID}"
    assert rule["status"] == "approved"
    assert rule["sourceCitations"] == [
        {
            "source_type": "demo",
            "source_id": "refund-policy",
            "permalink": "docker-demo/refund-policy.md",
        }
    ]
    assert DEMO_DESCRIPTION in rule["body"]


def test_demo_curl_targets_the_real_stateless_mcp_tool_call():
    command = _curl("gnt_live_disposable_demo_key")

    assert "http://localhost:8000/mcp/" in command
    assert "Authorization: Bearer gnt_live_disposable_demo_key" in command
    assert '"method":"tools/call"' in command
    assert '"name":"check_action"' in command
    assert DEMO_DESCRIPTION in command

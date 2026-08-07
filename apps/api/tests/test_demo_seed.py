import uuid

import pytest

from demo.seed_compose import DEMO_DESCRIPTION, DEMO_RULE_ID, _curl, _demo_rule, _validate_demo_payload


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


def test_demo_payload_requires_retrieval_and_the_keyless_fail_closed_verdict(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    _validate_demo_payload({"rules_retrieved": 1, "verdict": "needs_human"})
    with pytest.raises(RuntimeError, match="seeded rule was not retrieved"):
        _validate_demo_payload({"rules_retrieved": 0, "verdict": "needs_human"})
    with pytest.raises(RuntimeError, match="expected fail-closed needs_human verdict"):
        _validate_demo_payload({"rules_retrieved": 1, "verdict": "allowed"})

"""Behavior tests for the gnt-guarded Pydantic AI refund example."""

import asyncio
from dataclasses import dataclass, field
from typing import Literal

from pydantic_ai.models.test import TestModel

from src.pydantic_ai_check_action import (
    CheckActionResult,
    CitedRule,
    GntMcpChecker,
    GuardedActionResult,
    RefundDependencies,
    build_refund_agent,
    execute_refund_order,
)


def _verdict(value: Literal["allowed", "blocked", "needs_human"]) -> CheckActionResult:
    """Build one deterministic gnt result for a guarded-action test."""
    return CheckActionResult(
        verdict=value,
        reason="Example policy result",
        cited_rules=[CitedRule(id="refund-policy", title="Refund policy")],
        rules_retrieved=1,
    )


@dataclass
class FakeChecker:
    """Record proposed actions and return one configured policy verdict."""

    result: CheckActionResult
    calls: list[tuple[str, str]] = field(default_factory=list)

    async def check_action(self, *, description: str, context: str) -> CheckActionResult:
        """Record the policy input before returning the configured result."""
        self.calls.append((description, context))
        return self.result


@dataclass
class FakeToolset:
    """Return one mapped MCP result without opening a network connection."""

    response: object
    calls: list[tuple[str, dict[str, str]]] = field(default_factory=list)

    async def direct_call_tool(self, name: str, arguments: dict[str, str]) -> object:
        """Record the direct tool call and return its configured result shape."""
        self.calls.append((name, arguments))
        return self.response


def test_gnt_checker_accepts_pydantic_ai_structured_result():
    """Parse the raw dictionary returned by Pydantic AI's direct MCP call."""
    toolset = FakeToolset(_verdict("allowed").model_dump())
    checker = GntMcpChecker(toolset)

    result = asyncio.run(checker.check_action(description="Refund order", context="Example"))

    assert result.verdict == "allowed"
    assert toolset.calls == [
        (
            "check_action",
            {"description": "Refund order", "context": "Example"},
        )
    ]


def test_gnt_checker_accepts_pydantic_ai_text_result():
    """Parse JSON text from an MCP server without a declared output schema."""
    toolset = FakeToolset(_verdict("blocked").model_dump_json())
    checker = GntMcpChecker(toolset)

    result = asyncio.run(checker.check_action(description="Refund order", context="Example"))

    assert result.verdict == "blocked"


def test_allowed_verdict_checks_policy_before_executing_refund():
    """Execute the side effect only after gnt returns ``allowed``."""
    checker = FakeChecker(_verdict("allowed"))
    events: list[str] = []

    async def refund_action(order_id: str, amount: float) -> str:
        """Record the observable side effect used by this test."""
        events.append(f"refund:{order_id}:{amount:.2f}")
        return "mock action executed"

    result = asyncio.run(
        execute_refund_order(
            checker,
            order_id="#8021",
            amount=750,
            refund_action=refund_action,
        )
    )

    assert checker.calls == [
        (
            "Refund order #8021 for $750.00.",
            "The refund is a simulated side effect in the gnt Pydantic AI example.",
        )
    ]
    assert events == ["refund:#8021:750.00"]
    assert result == GuardedActionResult(status="executed", message="mock action executed")


def test_blocked_verdict_never_executes_refund():
    """Keep the side effect unreachable when gnt blocks the action."""
    checker = FakeChecker(_verdict("blocked"))
    executed = False

    async def refund_action(_order_id: str, _amount: float) -> str:
        """Fail the safety assertion if the blocked branch calls this function."""
        nonlocal executed
        executed = True
        return "should not run"

    result = asyncio.run(
        execute_refund_order(
            checker,
            order_id="#8021",
            amount=750,
            refund_action=refund_action,
        )
    )

    assert executed is False
    assert result.status == "blocked"
    assert "Refund policy" in result.message


def test_needs_human_verdict_never_executes_refund():
    """Keep the side effect unreachable while gnt awaits human approval."""
    checker = FakeChecker(_verdict("needs_human"))
    executed = False

    async def refund_action(_order_id: str, _amount: float) -> str:
        """Fail the safety assertion if the approval branch calls this function."""
        nonlocal executed
        executed = True
        return "should not run"

    result = asyncio.run(
        execute_refund_order(
            checker,
            order_id="#8021",
            amount=750,
            refund_action=refund_action,
        )
    )

    assert executed is False
    assert result.status == "needs_human"
    assert "ask a human" in result.message


def test_pydantic_agent_tool_calls_gnt_checker():
    """Exercise the registered Pydantic AI tool through a deterministic model."""
    checker = FakeChecker(_verdict("allowed"))
    agent = build_refund_agent(TestModel(call_tools=["refund_order"]))

    result = asyncio.run(
        agent.run(
            "Refund order #8021 for $750.",
            deps=RefundDependencies(checker=checker),
        )
    )

    assert checker.calls
    assert "Mock refund executed" in result.output

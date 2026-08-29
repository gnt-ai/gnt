"""Pydantic AI refund example guarded by gnt's ``check_action`` MCP tool."""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated, Any, Literal, Protocol

from pydantic import BaseModel, Field
from pydantic_ai import Agent, RunContext
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.models import Model

DEFAULT_GNT_MCP_URL = "https://api.gntai.dev/mcp/"
DEFAULT_PYDANTIC_AI_MODEL = "openai:gpt-4.1-mini"


class CitedRule(BaseModel):
    """Identify an approved rule cited by gnt's policy verdict."""

    id: str
    title: str


class CheckActionResult(BaseModel):
    """Validate the structured result returned by gnt's ``check_action`` tool."""

    verdict: Literal["allowed", "blocked", "needs_human"]
    reason: str
    cited_rules: list[CitedRule]
    rules_retrieved: int


class GuardedActionResult(BaseModel):
    """Describe whether the mock refund was executed or withheld."""

    status: Literal["executed", "blocked", "needs_human"]
    message: str


class GntChecker(Protocol):
    """Define the small gnt boundary needed by the Pydantic AI tool."""

    async def check_action(self, *, description: str, context: str) -> CheckActionResult:
        """Return gnt's policy verdict for one proposed action."""


@dataclass
class RefundDependencies:
    """Provide the Pydantic AI tool with its policy checker."""

    checker: GntChecker


RefundAction = Callable[[str, float], Awaitable[str]]


class GntMcpChecker:
    """Call gnt through Pydantic AI's current streamable-HTTP MCP client."""

    def __init__(self, toolset: MCPToolset[Any]):
        """Store the configured MCP toolset used for direct policy checks."""
        self._toolset = toolset

    async def check_action(self, *, description: str, context: str) -> CheckActionResult:
        """Call ``check_action`` and validate its structured response."""
        response = await self._toolset.direct_call_tool(
            "check_action",
            {"description": description, "context": context},
        )

        payload = _structured_payload(response)
        return CheckActionResult.model_validate(payload)


def _structured_payload(response: Any) -> dict[str, Any]:
    """Extract a JSON object from FastMCP's structured or text result forms."""
    # Pydantic AI maps a successful structured MCP result to the raw dictionary.
    if isinstance(response, dict):
        return response
    if isinstance(response, str):
        candidate = json.loads(response)
        if isinstance(candidate, dict):
            return candidate

    # Retain compatibility with callers that expose the original MCP result object.
    for candidate in (
        getattr(response, "data", None),
        getattr(response, "structured_content", None),
    ):
        if isinstance(candidate, dict):
            return candidate

    # Older or proxying MCP servers may return only a JSON text content block.
    for block in getattr(response, "content", []):
        text = getattr(block, "text", None)
        if isinstance(text, str):
            candidate = json.loads(text)
            if isinstance(candidate, dict):
                return candidate

    raise ValueError("gnt returned check_action in an unexpected response shape")


async def mock_refund(order_id: str, amount: float) -> str:
    """Simulate the side effect that must remain behind the gnt verdict."""
    return f"Mock refund executed for order {order_id}: ${amount:.2f}."


def _cited_rules(result: CheckActionResult) -> str:
    """Render the policy citations included in a non-allowed verdict."""
    if not result.cited_rules:
        return "No rule was cited."
    titles = ", ".join(rule.title for rule in result.cited_rules)
    return f"Cited rule(s): {titles}."


async def execute_refund_order(
    checker: GntChecker,
    *,
    order_id: str,
    amount: float,
    refund_action: RefundAction = mock_refund,
) -> GuardedActionResult:
    """Check gnt immediately before executing the supplied refund action."""
    check = await checker.check_action(
        description=f"Refund order {order_id} for ${amount:.2f}.",
        context="The refund is a simulated side effect in the gnt Pydantic AI example.",
    )

    # The side effect is reachable only from the explicit allowed branch.
    if check.verdict == "allowed":
        return GuardedActionResult(
            status="executed",
            message=await refund_action(order_id, amount),
        )
    if check.verdict == "blocked":
        return GuardedActionResult(
            status="blocked",
            message=f"Action was not executed: {check.reason} {_cited_rules(check)}",
        )
    return GuardedActionResult(
        status="needs_human",
        message=(
            "Action was not executed; ask a human to approve it: "
            f"{check.reason} {_cited_rules(check)}"
        ),
    )


def build_refund_agent(model: Model | str | None = None) -> Agent[RefundDependencies, str]:
    """Build a Pydantic AI agent exposing one gnt-guarded refund tool."""
    selected_model = model or os.getenv("PYDANTIC_AI_MODEL", DEFAULT_PYDANTIC_AI_MODEL)
    agent = Agent(
        selected_model,
        deps_type=RefundDependencies,
        instructions=(
            "Help with the refund request by calling refund_order exactly once. "
            "Report the guarded result without claiming an unexecuted refund succeeded."
        ),
    )

    @agent.tool
    async def refund_order(
        ctx: RunContext[RefundDependencies],
        order_id: Annotated[
            str,
            Field(description="Order identifier to refund", min_length=1),
        ],
        amount: Annotated[
            float,
            Field(description="Refund amount in US dollars", gt=0),
        ],
    ) -> GuardedActionResult:
        """Refund an order only after gnt's policy check allows it."""
        return await execute_refund_order(
            ctx.deps.checker,
            order_id=order_id,
            amount=amount,
        )

    return agent


def _required_environment(name: str) -> str:
    """Read a required environment value without exposing it in errors or output."""
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required; copy examples/.env.example and set it")
    return value


async def main() -> None:
    """Run the guarded refund example against the configured gnt MCP server."""
    gnt_key = _required_environment("GNT_MCP_KEY")
    toolset = MCPToolset(
        os.getenv("GNT_MCP_URL", DEFAULT_GNT_MCP_URL),
        headers={"Authorization": f"Bearer {gnt_key}"},
        tool_error_behavior="error",
    )
    dependencies = RefundDependencies(checker=GntMcpChecker(toolset))
    agent = build_refund_agent()

    result = await agent.run("Refund order #8021 for $750.", deps=dependencies)
    print(result.output)


if __name__ == "__main__":
    asyncio.run(main())

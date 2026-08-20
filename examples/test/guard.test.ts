import assert from "node:assert/strict";
import test from "node:test";

import { RunContext } from "@openai/agents";

import { createRefundOrderTool } from "../src/openai-agents-sdk-check-action.js";
import { parseRefundInput, runGuardedAction } from "../src/guard.js";
import type { CheckActionResult } from "../src/gnt-mcp.js";

function verdict(verdictValue: CheckActionResult["verdict"]): CheckActionResult {
  return {
    verdict: verdictValue,
    reason: "Example policy result",
    cited_rules: [{ id: "refund-policy", title: "Refund policy" }],
    rules_retrieved: 1,
  };
}

test("allowed executes the risky action", async () => {
  const result = await runGuardedAction(verdict("allowed"), async () => "mock action executed");
  assert.deepEqual(result, { status: "executed", message: "mock action executed" });
});

test("blocked never executes the risky action", async () => {
  let ran = false;
  const result = await runGuardedAction(verdict("blocked"), async () => {
    ran = true;
    return "should not run";
  });

  assert.equal(ran, false);
  assert.equal(result.status, "blocked");
  assert.match(result.message, /Example policy result/);
});

test("needs_human never executes the risky action", async () => {
  let ran = false;
  const result = await runGuardedAction(verdict("needs_human"), async () => {
    ran = true;
    return "should not run";
  });

  assert.equal(ran, false);
  assert.equal(result.status, "needs_human");
  assert.match(result.message, /ask a human/i);
});

test("refund input requires a non-empty order id and a finite positive amount", () => {
  assert.deepEqual(parseRefundInput({ orderId: "  #8021  ", amount: 750 }), {
    orderId: "#8021",
    amount: 750,
  });

  for (const input of [
    null,
    [],
    { orderId: "", amount: 750 },
    { orderId: "   ", amount: 750 },
    { orderId: "#8021", amount: 0 },
    { orderId: "#8021", amount: -1 },
    { orderId: "#8021", amount: Number.NaN },
    { orderId: "#8021", amount: Number.POSITIVE_INFINITY },
  ]) {
    assert.equal(parseRefundInput(input), undefined);
  }
});

test("OpenAI Agents refund tool checks gnt before executing", async () => {
  const calls: string[] = [];
  const refundTool = createRefundOrderTool({
    async checkAction(input) {
      calls.push(`${input.description} ${input.context}`);
      return verdict("allowed");
    },
  });
  const result = await refundTool.invoke(
    new RunContext(),
    JSON.stringify({ orderId: "#8021", amount: 750 }),
  );

  assert.deepEqual(calls, [
    "Refund order #8021 for $750.00. The refund is a simulated side effect in the gnt OpenAI Agents SDK example.",
  ]);
  assert.deepEqual(result, {
    status: "executed",
    message: "Mock refund executed for order #8021: $750.00.",
  });
});

test("OpenAI Agents refund tool respects a blocked verdict", async () => {
  const refundTool = createRefundOrderTool({
    async checkAction() {
      return verdict("blocked");
    },
  });
  const result = await refundTool.invoke(
    new RunContext(),
    JSON.stringify({ orderId: "#8021", amount: 750 }),
  );

  assert.deepEqual(result, {
    status: "blocked",
    message: "Action was not executed: Example policy result Cited rule(s): Refund policy.",
  });
});

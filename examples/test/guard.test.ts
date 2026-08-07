import assert from "node:assert/strict";
import test from "node:test";

import { runGuardedAction } from "../src/guard.js";
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

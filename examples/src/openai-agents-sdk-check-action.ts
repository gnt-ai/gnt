import { pathToFileURL } from "node:url";

import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";

import { connectGntMcp } from "./gnt-mcp.js";
import {
  mockRefund,
  runGuardedAction,
  type GuardedActionResult,
  type RefundInput,
} from "./guard.js";
import type { GntMcpClient } from "./gnt-mcp.js";

type GntChecker = Pick<GntMcpClient, "checkAction">;

export async function executeRefundOrder(
  gnt: GntChecker,
  { orderId, amount }: RefundInput,
): Promise<GuardedActionResult> {
  const check = await gnt.checkAction({
    description: `Refund order ${orderId} for $${amount.toFixed(2)}.`,
    context: "The refund is a simulated side effect in the gnt OpenAI Agents SDK example.",
  });

  return runGuardedAction(check, () => mockRefund(orderId, amount));
}

export function createRefundOrderTool(gnt: GntChecker) {
  return tool({
    name: "refund_order",
    description: "Refund an order only after gnt's policy check allows it.",
    parameters: z.object({
      orderId: z
        .string()
        .trim()
        .min(1, { error: "orderId is required" })
        .describe("The order to refund"),
      amount: z.number().finite().positive().describe("Refund amount in US dollars"),
    }),
    execute: (input) => executeRefundOrder(gnt, input),
  });
}

export function createRefundAgent(gnt: GntChecker) {
  return new Agent({
    name: "Gnt-guarded refund agent",
    model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    instructions:
      "You handle refund requests. Use refund_order for every refund, and report the policy result " +
      "without claiming a refund ran when the tool did not execute it.",
    tools: [createRefundOrderTool(gnt)],
  });
}

export async function runExample(): Promise<void> {
  const gnt = await connectGntMcp();
  try {
    const agent = createRefundAgent(gnt);
    const result = await run(agent, "Refund order #8021 for $750.");
    console.log(result.finalOutput);
  } finally {
    await gnt.close();
  }
}

const invokedFile = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedFile === import.meta.url) {
  runExample().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

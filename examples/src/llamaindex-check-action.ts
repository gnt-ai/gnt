import { pathToFileURL } from "node:url";

import { tool } from "llamaindex";
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

const refundInputSchema = z.object({
  orderId: z
    .string()
    .trim()
    .min(1, { error: "orderId is required" })
    .describe("The order to refund"),
  amount: z.number().finite().positive().describe("Refund amount in US dollars"),
});

export async function executeRefundOrder(
  gnt: GntChecker,
  { orderId, amount }: RefundInput,
): Promise<GuardedActionResult> {
  const check = await gnt.checkAction({
    description: `Refund order ${orderId} for $${amount.toFixed(2)}.`,
    context: "The refund is a simulated side effect in the gnt LlamaIndex example.",
  });

  return runGuardedAction(check, () => mockRefund(orderId, amount));
}

export function createRefundOrderTool(gnt: GntChecker) {
  return tool({
    name: "refund_order",
    description: "Refund an order only after gnt's policy check allows it.",
    parameters: refundInputSchema,
    execute: async (input) => JSON.stringify(await executeRefundOrder(gnt, input)),
  });
}

export async function runExample(): Promise<void> {
  const gnt = await connectGntMcp();
  try {
    const refundTool = createRefundOrderTool(gnt);
    const result = await refundTool.call({ orderId: "#8021", amount: 750 });
    console.log(result);
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

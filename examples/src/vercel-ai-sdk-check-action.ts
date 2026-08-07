import { tool } from "ai";
import { z } from "zod";

import { connectGntMcp } from "./gnt-mcp.js";
import { mockRefund, runGuardedAction } from "./guard.js";

const refundOrder = tool({
  description: "Refund an order only after gnt's policy check allows it.",
  inputSchema: z.object({
    orderId: z.string().describe("The order to refund"),
    amount: z.number().positive().describe("Refund amount in US dollars"),
  }),
  async execute({ orderId, amount }) {
    const gnt = await connectGntMcp();
    try {
      const check = await gnt.checkAction({
        description: `Refund order ${orderId} for $${amount.toFixed(2)}.`,
        context: "The refund is a simulated side effect in the gnt Vercel AI SDK example.",
      });
      return runGuardedAction(check, () => mockRefund(orderId, amount));
    } finally {
      await gnt.close();
    }
  },
});

if (!refundOrder.execute) throw new Error("The Vercel AI SDK tool did not expose an execute function.");

const result = await refundOrder.execute(
  { orderId: "#8021", amount: 750 },
  { toolCallId: "gnt-example-refund", messages: [] },
);
console.log(JSON.stringify(result));

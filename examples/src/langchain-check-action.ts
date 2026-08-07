import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { connectGntMcp } from "./gnt-mcp.js";
import { mockRefund, runGuardedAction } from "./guard.js";

const refundOrder = tool(
  async ({ orderId, amount }) => {
    const gnt = await connectGntMcp();
    try {
      const check = await gnt.checkAction({
        description: `Refund order ${orderId} for $${amount.toFixed(2)}.`,
        context: "The refund is a simulated side effect in the gnt LangChain example.",
      });
      return JSON.stringify(await runGuardedAction(check, () => mockRefund(orderId, amount)));
    } finally {
      await gnt.close();
    }
  },
  {
    name: "refund_order",
    description: "Refund an order only after gnt's policy check allows it.",
    schema: z.object({
      orderId: z.string().describe("The order to refund"),
      amount: z.number().positive().describe("Refund amount in US dollars"),
    }),
  },
);

const result = await refundOrder.invoke({ orderId: "#8021", amount: 750 });
console.log(result);

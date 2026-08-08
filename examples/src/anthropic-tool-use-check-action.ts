import Anthropic from "@anthropic-ai/sdk";

import { connectGntMcp } from "./gnt-mcp.js";
import { mockRefund, parseRefundInput, runGuardedAction } from "./guard.js";

const MAX_TOOL_USE_ROUNDS = 5;
const anthropic = new Anthropic();
const gnt = await connectGntMcp();

const messages: Anthropic.MessageParam[] = [
  { role: "user", content: "Refund order #8021 for $750." },
];

try {
  for (let round = 0; round < MAX_TOOL_USE_ROUNDS; round += 1) {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5",
      max_tokens: 512,
      messages,
      tools: [
        {
          name: "refund_order",
          description: "Refund an order. The implementation checks gnt before performing this action.",
          input_schema: {
            type: "object",
            properties: {
              orderId: { type: "string", description: "The order to refund" },
              amount: { type: "number", description: "Refund amount in US dollars" },
            },
            required: ["orderId", "amount"],
            additionalProperties: false,
          },
        },
      ],
    });

    messages.push({ role: "assistant", content: response.content });
    const toolUses = response.content.filter((block) => block.type === "tool_use");
    if (toolUses.length === 0) {
      console.log(response.content);
      break;
    }

    if (round === MAX_TOOL_USE_ROUNDS - 1) {
      throw new Error(`Anthropic kept requesting tools after ${MAX_TOOL_USE_ROUNDS} rounds.`);
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const input = parseRefundInput(toolUse.input);
      if (!input) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: true,
          content: "refund_order requires a non-empty string orderId and a finite positive amount.",
        });
        continue;
      }

      const { orderId, amount } = input;
      const check = await gnt.checkAction({
        description: `Refund order ${orderId} for $${amount.toFixed(2)}.`,
        context: "The refund is a simulated side effect in the gnt Anthropic tool-use example.",
      });
      const outcome = await runGuardedAction(check, () => mockRefund(orderId, amount));
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: JSON.stringify(outcome),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
} finally {
  await gnt.close();
}

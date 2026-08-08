import type { CheckActionResult } from "./gnt-mcp.js";

export interface GuardedActionResult {
  status: "executed" | "blocked" | "needs_human";
  message: string;
}

export interface RefundInput {
  orderId: string;
  amount: number;
}

export function parseRefundInput(value: unknown): RefundInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const { orderId, amount } = value as { orderId?: unknown; amount?: unknown };
  if (typeof orderId !== "string" || orderId.trim() === "") return undefined;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return undefined;

  return { orderId: orderId.trim(), amount };
}

function citedRules(result: CheckActionResult): string {
  return result.cited_rules.length === 0
    ? "No rule was cited."
    : `Cited rule(s): ${result.cited_rules.map((rule) => rule.title).join(", ")}.`;
}

export async function runGuardedAction(
  result: CheckActionResult,
  riskyAction: () => Promise<string>,
): Promise<GuardedActionResult> {
  switch (result.verdict) {
    case "allowed":
      return { status: "executed", message: await riskyAction() };
    case "blocked":
      return {
        status: "blocked",
        message: `Action was not executed: ${result.reason} ${citedRules(result)}`,
      };
    case "needs_human":
      return {
        status: "needs_human",
        message: `Action was not executed; ask a human to approve it: ${result.reason} ${citedRules(result)}`,
      };
  }
}

export async function mockRefund(orderId: string, amount: number): Promise<string> {
  return `Mock refund executed for order ${orderId}: $${amount.toFixed(2)}.`;
}

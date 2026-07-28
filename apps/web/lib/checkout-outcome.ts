// Pulled out of onboarding-billing-client.tsx's startTrial so the
// ok/status branching -- success, or a 503 (billing not configured in
// this environment) degrades to /welcome instead of locking the signup
// out, or any other failure shows a retry error -- is testable without
// mocking fetch or rendering the component.
export function checkoutOutcome(ok: boolean, status: number): "success" | "degrade" | "error" {
  if (ok) return "success";
  if (status === 503) return "degrade";
  return "error";
}

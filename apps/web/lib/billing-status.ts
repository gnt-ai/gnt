import { db } from "@/lib/auth";

// Server-side, no-network-hop version of what billing-gate.tsx checks
// client-side (GET /v1/billing/status, non-null subscription_status).
// Same physical Postgres apps/api's Alembic migrations own (see
// lib/auth.ts's own comment) -- reading orgs.subscription_status directly
// is exactly what that endpoint itself does, just without a round trip
// through a server-minted token and a fetch. Used by server components
// that need to redirect to /onboarding/billing BEFORE rendering anything,
// instead of BillingGate's client-side redirect, which fires after a
// flash of the page's real content -- welcome/page.tsx and
// onboarding/organization/page.tsx being the two places that flash was
// actually visible.
export async function isOrgEntitledForWeb(orgId: string): Promise<boolean> {
  const { rows } = await db.query("select subscription_status from orgs where id = $1", [orgId]);
  return rows[0]?.subscription_status != null;
}

"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { API_URL } from "@/lib/api-url";
import { authClient, useSession } from "@/lib/auth-client";
import { checkBillingRedirect } from "@/lib/billing-gate-logic";

// A card is required to start a trial now (onboarding/billing/page.tsx),
// but ensure_org (apps/api/src/gnt/db/org.py) still auto-grants a
// 14-day local trial to every org on first creation regardless -- that's
// deliberate, it's what keeps a CLI/MCP-first org (one that never touches
// the web dashboard at all) working the moment it's created, and
// apps/api's own is_org_entitled correctly treats that local trial as
// real entitlement for the CLI/MCP surface. But it means someone who
// creates an org through the web flow and closes the tab before finishing
// Checkout was landing on /welcome anyway -- is_org_entitled said yes,
// nothing on the web side ever checked further.
//
// This is the web-specific, stricter check: subscription_status is only
// ever non-null once an org has actually completed Checkout at least
// once (routers/billing.py's webhook handler is the only thing that sets
// it). Mounted on every page reachable right after sign-in/org-creation
// (welcome, settings/security, settings/organization), same "gate every
// entry point, not just the one you expect people to use" posture as
// TwoFactorGate.
export function BillingGate() {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const checked = useRef(false);

  useEffect(() => {
    if (isPending || !session || checked.current) return;
    checked.current = true;

    let cancelled = false;
    async function check() {
      const { data, error } = await authClient.token();
      const token = data?.token;
      if (error || !token) return;
      // /v1/billing/status is require_admin-gated -- a non-admin member
      // invited to a not-yet-paid org gets a 403 here, which
      // checkBillingRedirect's !res.ok check treats the same as "don't
      // redirect". That's the right outcome, not an accident to route
      // around: billing is the owner/admin's problem to solve, an invited
      // teammate shouldn't get bounced to a card form for someone else's
      // org. A network hiccup fails open the same way -- shouldn't strand
      // someone who's already paid on a blank page. The real enforcement
      // is apps/api's own is_org_entitled on every billable action, not
      // this redirect.
      const shouldRedirect = await checkBillingRedirect(() =>
        fetch(`${API_URL}/v1/billing/status`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      if (!cancelled && shouldRedirect) router.replace("/onboarding/billing");
    }
    check();
    return () => {
      cancelled = true;
    };
  }, [isPending, session, router]);

  return null;
}

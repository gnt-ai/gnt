"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { DashboardFooter } from "@/components/dashboard-footer";
import { DashboardHeader } from "@/components/dashboard-header";
import { API_URL } from "@/lib/api-url";
import { authClient } from "@/lib/auth-client";

const POLL_MS = 800;
const MAX_POLLS = 12; // ~10s, generous past the webhook's usual 1-2s

// Stripe Checkout's success_url (gnt/billing.py's create_checkout_session)
// for both the web onboarding flow (onboarding/billing/page.tsx) and
// `gnt billing` (apps/cli/src/commands/billing.ts, opened in the default
// browser) -- this page didn't exist at all before, so completing a real
// checkout landed on a 404.
//
// Used to redirect to /welcome on a blind 1.5s timer, on the assumption
// the webhook that actually flips subscription_status would always have
// landed first. That held while /welcome had no entitlement check of its
// own -- once welcome/page.tsx started checking subscription_status
// server-side (so an unpaid org never sees a flash of its real content),
// a real checkout could lose the race against its own webhook: land here,
// get redirected to /welcome before the webhook wrote anything, and get
// bounced straight back to /onboarding/billing despite having just paid.
// Polling /v1/billing/status here instead means the redirect only ever
// fires once entitlement is actually confirmed -- or, if the webhook is
// genuinely slow/stuck, after a generous timeout, same fail-open posture
// as onboarding-status.tsx's own polling.
export default function BillingSuccessPage() {
  const router = useRouter();
  const attempts = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      attempts.current += 1;
      try {
        const { data, error } = await authClient.token();
        const token = data?.token;
        if (error || !token) throw new Error("no session token");
        const res = await fetch(`${API_URL}/v1/billing/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const status = await res.json();
          if (status.subscription_status) {
            if (!cancelled) router.push("/welcome");
            return;
          }
        }
      } catch {
        // Fall through to retry/timeout below -- a network hiccup here
        // shouldn't strand someone who just paid on this page forever.
      }
      if (attempts.current >= MAX_POLLS) {
        if (!cancelled) router.push("/welcome");
        return;
      }
      setTimeout(poll, POLL_MS);
    }

    poll();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="flex-1 flex flex-col">
      <DashboardHeader />
      <main className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-3">
        <p className="font-mono text-sm text-foreground">You&apos;re all set.</p>
        <p className="font-mono text-sm text-muted">Taking you to your account…</p>
      </main>
      <DashboardFooter />
    </div>
  );
}

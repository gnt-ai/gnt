"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { OnboardingFooter } from "@/components/onboarding-footer";
import { OnboardingHeader } from "@/components/onboarding-header";
import { API_URL } from "@/lib/api-url";
import { authClient } from "@/lib/auth-client";
import { checkoutOutcome } from "@/lib/checkout-outcome";
import type { auth } from "@/lib/auth";

type ServerSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

type Tier = "base" | "pro";

const TIERS: Array<{
  id: Tier;
  name: string;
  price: string;
  desc: string;
  trialNote: string;
  bullets: string[];
}> = [
  {
    id: "base",
    name: "Base",
    price: "$29/mo",
    desc: "1,500 check_action calls a month.",
    trialNote: "14-day free trial",
    bullets: ["Everything in gnt.ai", "One org, one team"],
  },
  {
    id: "pro",
    name: "Pro",
    price: "$149/mo",
    desc: "8,000 check_action calls a month.",
    trialNote: "No trial — billed immediately",
    bullets: ["Everything in Base", "Invite people already on another org"],
  },
];

// A brand-new org lands here right after creation (see
// onboarding/organization/page.tsx). Base gets a 14-day trial -- a card is
// required to start it, same as any real Stripe-backed trial, not charged
// until it converts. Pro has no trial -- it's billed immediately on
// checkout (see routers/billing.py's checkout(), which only ever passes
// trial_days for tier == "base"). Nothing about switching tiers later is
// locked in by this choice (gnt billing/the customer portal handle that).
//
// The session is already resolved server-side (see page.tsx) -- this only
// owns what's genuinely client-only: the tier picker and the checkout POST.
export function OnboardingBillingClient({ session }: { session: ServerSession }) {
  const router = useRouter();
  const [tier, setTier] = useState<Tier>("base");
  const hasTrial = tier === "base";
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startTrial() {
    setError(null);
    setStarting(true);
    const { data, error: tokenError } = await authClient.token();
    const token = data?.token;
    if (tokenError || !token) {
      setStarting(false);
      setError("Couldn't verify your session. Try again.");
      return;
    }
    try {
      const res = await fetch(`${API_URL}/v1/billing/checkout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      const outcome = checkoutOutcome(res.ok, res.status);
      if (outcome === "degrade") {
        setStarting(false);
        // Billing genuinely not configured in this environment (a fresh
        // local dev setup with no Stripe keys, say) -- degrade instead of
        // permanently locking every new signup out of the product over an
        // environment gap that isn't the visitor's problem to solve.
        router.push("/welcome");
        return;
      }
      if (outcome === "error") {
        setStarting(false);
        setError("Couldn't start checkout. Try again in a moment.");
        return;
      }
      const { url } = await res.json();
      window.location.href = url;
    } catch {
      setStarting(false);
      setError("Couldn't reach billing. Check your connection and try again.");
    }
  }

  return (
    <div className="flex-1 flex flex-col">
      <OnboardingHeader initialSession={session} />
      <main className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-lg flex flex-col gap-8">
          <div className="flex flex-col gap-1.5">
            <h1 className="font-mono text-2xl font-bold tracking-tight">
              {hasTrial ? "Start your trial" : "Subscribe to Pro"}
            </h1>
            <p className="font-mono text-sm text-muted">
              {hasTrial
                ? "14 days free, then Base. Cancel anytime before it converts and you won't be charged."
                : "Pro is billed immediately — no trial on this tier. Switch to Base first if you want to try it free."}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {TIERS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTier(t.id)}
                className={`text-left rounded-[4px] border px-5 py-4 transition-colors duration-150 ease-out-strong ${
                  tier === t.id ? "border-foreground/60 bg-surface" : "border-border hover:border-foreground/30"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-sm font-bold">{t.name}</span>
                  <span className="font-mono text-sm text-foreground">{t.price}</span>
                </div>
                <p className="font-mono text-xs text-muted mt-1">{t.desc}</p>
                <p className={`font-mono text-xs mt-1 ${t.id === "base" ? "text-success" : "text-muted"}`}>
                  {t.trialNote}
                </p>
                <ul className="mt-3 flex flex-col gap-1">
                  {t.bullets.map((b) => (
                    <li key={b} className="font-mono text-xs text-muted">
                      · {b}
                    </li>
                  ))}
                </ul>
              </button>
            ))}
          </div>

          {error && <p className="text-sm text-error">{error}</p>}

          <button
            type="button"
            onClick={startTrial}
            disabled={starting}
            className="rounded-[4px] bg-accent-brand text-accent-brand-foreground font-mono text-sm font-medium hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong py-2 disabled:opacity-50"
          >
            {starting ? "Starting..." : hasTrial ? "Add a card and start trial" : "Add a card and subscribe"}
          </button>
        </div>
      </main>
      <OnboardingFooter />
    </div>
  );
}

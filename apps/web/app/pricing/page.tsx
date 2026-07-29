import type { Metadata } from "next";
import Link from "next/link";
import { Check } from "lucide-react";
import { FaqList } from "@/components/faq-list";
import { MarketingFooter } from "@/components/marketing-footer";
import { MarketingHeader } from "@/components/marketing-header";

const TITLE = "Pricing · gnt.ai";
const DESCRIPTION =
  "Two flat tiers, priced by usage, not headcount. 1,500 or 8,000 check_action calls a month. 14-day free trial on Base.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { type: "website", title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

// Every real number here comes straight from apps/api/src/gnt/plan_limits.py
// and billing.py -- nothing on this page is placeholder copy. Base carries
// the full feature list; Pro only lists what's different (plan_limits.py/
// auth.ts only ever gate two things: the monthly cap, shown above each
// card's own list, and cross-org invites, Pro's one extra line below) --
// repeating the shared list a second time read as padding, not detail.
const TIERS: Array<{
  id: string;
  name: string;
  subhead: string;
  price: string;
  cap: string;
  trial: string;
  trialAccent: boolean;
  featured: boolean;
  lead: string | null;
  features: string[];
}> = [
  {
    id: "base",
    name: "Base",
    subhead: "For a single team getting started.",
    price: "$29",
    cap: "1,500 check_action calls a month",
    trial: "14-day free trial",
    trialAccent: true,
    featured: false,
    lead: null,
    features: [
      "One org, one team",
      "check_action enforcement: allowed, blocked, or needs_human, with the rule that decided it",
      "Git-native rules: files in your repo, reviewed and merged like code",
      "gnt prebrain: first rules drafted from your repo, docs, and connectors",
      "Staleness and contradiction detection, running automatically",
      "Skill packs: versioned, pullable, verifiable by hash",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    subhead: "More headroom before you hit the cap, plus multi-org access.",
    price: "$149",
    cap: "8,000 check_action calls a month",
    trial: "No trial, billed immediately",
    trialAccent: false,
    featured: true,
    lead: "Everything in Base, plus:",
    features: ["Invite people already on another org", "Lower cost per check_action call than Base"],
  },
];

// Deliberately not the rest of the site's product FAQ (that one lives on
// the homepage, app/page.tsx) -- these are billing-specific, and every
// answer is grounded in real billing.py/plan_limits.py/action_check.py
// behavior, not aspirational copy.
const FAQ = [
  {
    q: "What happens if we go over the monthly cap?",
    a: "check_action doesn't fail or lock you out. Calls past the cap degrade to needs_human, the same safe default it already uses whenever no rule clearly covers an action. Upgrade any time to raise the cap.",
  },
  {
    q: "Can we switch tiers later?",
    a: "Yes, any time, from Settings → Billing. Nothing about which tier you start on locks you in.",
  },
  {
    q: "Does Pro get a free trial too?",
    a: "No. The 14-day trial is a Base-only offer. Pro is billed immediately on checkout. Start on Base to try it free, then upgrade whenever.",
  },
  {
    q: "How do we cancel?",
    a: "Settings → Billing → Cancel subscription, right in the app. That's it."
  },
  {
    q: "Do we have to pay to use gnt?",
    a: "No. gnt is source-available under FSL-1.1-Apache-2.0 (it converts to Apache-2.0 two years after launch). Run docker compose up and you get the same API, MCP server, worker, and rules store on your own infrastructure, with your own keys, for free. These two tiers are for the hosted version: managed infra, upgrades, and support, so you don't have to run it yourself. See docs/self-hosting/README.md in the repo.",
  },
];

export default function PricingPage() {
  return (
    <div className="flex-1 flex flex-col">
      <MarketingHeader />

      <main className="flex-1">
        <section className="px-6 pt-8 pb-6 sm:pt-10 sm:pb-8 text-center max-w-xl mx-auto">
          <p className="font-mono text-xs font-semibold uppercase tracking-widest text-muted mb-2">Pricing</p>
          <h1 className="font-mono text-2xl sm:text-3xl font-bold tracking-tight mb-2 text-balance">
            Flat pricing. No per-seat tax.
          </h1>
          <p className="font-mono text-sm text-muted leading-relaxed text-balance">
            Two tiers, priced by usage, not headcount. Same product either way.
          </p>
        </section>

        <section className="px-6 pb-10">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 max-w-2xl mx-auto">
            {TIERS.map((tier) => (
              <div
                key={tier.id}
                className={
                  tier.featured
                    ? "relative flex flex-col rounded-xl border-2 border-accent-brand bg-surface-low px-6 py-5"
                    : "relative flex flex-col rounded-xl border border-border px-6 py-5"
                }
              >
                {tier.featured && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-accent-brand px-3 py-1 font-mono text-xs font-semibold uppercase tracking-wide text-accent-brand-foreground">
                    Most popular
                  </span>
                )}
                <h2 className="font-mono text-xs font-semibold uppercase tracking-widest text-muted mb-1">
                  {tier.name}
                </h2>
                <p className="font-mono text-sm text-foreground leading-snug mb-3 min-h-[2.5em]">{tier.subhead}</p>
                <div className="flex items-baseline gap-1 mb-1">
                  <span className="font-mono text-4xl font-bold tracking-tight">{tier.price}</span>
                  <span className="font-mono text-sm text-muted">/month</span>
                </div>
                <p className="font-mono text-sm text-muted leading-relaxed">{tier.cap}</p>
                <p
                  className={`font-mono text-xs mt-1 mb-4 ${tier.trialAccent ? "text-success" : "text-muted"}`}
                >
                  {tier.trial}
                </p>
                <Link
                  href="/sign-up"
                  className={
                    tier.featured
                      ? "inline-flex items-center justify-center rounded-[4px] bg-accent-brand px-5 py-1 font-mono text-sm font-medium leading-[2] text-accent-brand-foreground hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong mb-5"
                      : "inline-flex items-center justify-center rounded-[4px] border border-border px-5 py-1 font-mono text-sm font-medium leading-[2] text-foreground hover:border-foreground/30 transition-colors duration-150 ease-out-strong mb-5"
                  }
                >
                  {tier.trialAccent ? "Start free trial" : "Subscribe"}
                </Link>
                {tier.lead && (
                  <p className="font-mono text-sm font-medium text-foreground mb-2">{tier.lead}</p>
                )}
                <ul className="flex flex-col gap-2">
                  {tier.features.map((item) => (
                    <li key={item} className="flex gap-2 font-mono text-sm leading-relaxed">
                      <Check aria-hidden="true" className="size-4 shrink-0 mt-0.5 text-success" />
                      <span className="text-muted">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <section className="px-6 pb-16 max-w-lg mx-auto">
          <h2 className="font-mono text-lg font-bold tracking-tight mb-3 text-center">Questions</h2>
          <FaqList items={FAQ} />
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}

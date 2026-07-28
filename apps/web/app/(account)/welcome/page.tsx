import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AccountSidebarToggle } from "@/components/account-sidebar";
import { BillingGate } from "@/components/billing-gate";
import { OnboardingPaths } from "@/components/onboarding-paths";
import { OnboardingStatusList } from "@/components/onboarding-status";
import { TwoFactorGate } from "@/components/two-factor-gate";
import { TwoFactorNag } from "@/components/two-factor-nag";
import { getServerSession } from "@/lib/auth";
import { isOrgEntitledForWeb } from "@/lib/billing-status";

// The landing spot after sign-up/org-selection -- previously this didn't
// exist at all: TaskChooseOrganization sent everyone straight to
// /cli-login, which only works if a ?callback= query param survived the
// whole auth+org-selection redirect chain. It doesn't for anyone creating
// their first org (i.e. every brand-new signup, not just the multi-org
// edge case the old code comment described) -- Clerk's own task-flow
// redirect drops it. Landing there with no callback showed a "something
// went wrong" error to someone who'd just signed up cleanly. This page is
// the real destination now; cli-login stays reachable only when a
// callback is actually present.
//
// Two paths, not one -- handing setup to an agent is the fast path most
// people should take, but gnt.ai is still just a CLI underneath, so anyone
// who'd rather drive it by hand can. See components/onboarding-paths.tsx
// for why they're a toggle now instead of both stacked on the page.
export default async function WelcomePage() {
  const session = await getServerSession();
  // Found while verifying the account-pages auth refactor live: unlike
  // settings/* and onboarding/*, this page never actually checked for a
  // session server-side -- TwoFactorGate/BillingGate both no-op without
  // one instead of redirecting, so a signed-out visitor could load the
  // full "Set up gnt.ai for your team" page. No account-specific data
  // shown, but inconsistent with every other authenticated page now.
  if (!session) redirect("/sign-in");
  // Same server-side-before-render check as onboarding/organization/
  // page.tsx, for the same reason: BillingGate below still runs (a
  // subscription cancelled mid-session should still bounce someone out),
  // but this is what stops an unpaid org from ever seeing this page's
  // real content flash by first.
  const orgId = session.session.activeOrganizationId;
  if (orgId && !(await isOrgEntitledForWeb(orgId))) redirect("/onboarding/billing");
  return (
    <>
      {/* See components/two-factor-gate.tsx -- welcome is the landing spot
          for every sign-in path (OTP, OAuth, post-org-creation), so it's
          the first reliable choke point to catch a 2FA-enabled account
          that hasn't cleared this tab's TOTP challenge yet. */}
      <TwoFactorGate />
      {/* The server-side check above catches everyone on initial load;
          this is the live backstop for the rest of the time someone
          spends on this page -- a subscription that lapses, or a card
          that fails, while the tab stays open. */}
      <BillingGate />
      <header className="flex items-center gap-3 border-b border-border px-6 py-4">
        <AccountSidebarToggle />
        <h1 className="font-mono text-lg font-semibold text-foreground">Onboarding</h1>
      </header>
      <main className="flex-1 flex flex-col items-center px-6 py-8">
        <div className="w-full flex flex-col items-start gap-5 text-left">
          <div className="flex flex-col items-start gap-2">
            <p className="font-mono text-xs uppercase tracking-widest text-muted">Signed in</p>
            <h1 className="font-mono text-2xl font-bold tracking-tight">Set up gnt.ai for your team.</h1>
            <p className="font-mono text-sm text-muted">
              gnt.ai is CLI-first — the real work happens in your terminal, not here.
            </p>
          </div>

          <TwoFactorNag />

          {/* Live, not static -- polls the real backend state behind
              whichever path below someone actually takes (see
              components/onboarding-status.tsx). Renders nothing until the
              first successful poll, so a signed-out visit or a network
              hiccup just skips it instead of showing a broken checklist. */}
          <OnboardingStatusList />

          <OnboardingPaths />

          <div className="border-t border-border w-full pt-3">
            <Link
              href="/docs"
              className="group inline-flex items-center gap-1.5 font-mono text-sm text-foreground hover:opacity-80 transition-opacity duration-150 ease-out-strong"
            >
              Read the docs
              <ArrowRight className="h-3.5 w-3.5 transition-transform duration-150 ease-out-strong group-hover:translate-x-0.5" />
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}

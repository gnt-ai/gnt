import Link from "next/link";
import { DashboardFooter } from "@/components/dashboard-footer";
import { DashboardHeader } from "@/components/dashboard-header";

// Stripe Checkout's cancel_url -- see billing/success/page.tsx's comment
// for why this page has to exist at all. Points back at
// onboarding/billing (not /welcome): a card is required to start the
// trial, so backing out of Checkout means trying again, not skipping it.
export default function BillingCancelPage() {
  return (
    <div className="flex-1 flex flex-col">
      <DashboardHeader />
      <main className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-3">
        <p className="font-mono text-sm text-foreground">Checkout canceled.</p>
        <p className="font-mono text-sm text-muted max-w-sm">
          No card was charged. You&apos;ll need to add one to start your trial.
        </p>
        <Link
          href="/onboarding/billing"
          className="font-mono text-sm text-foreground underline hover:opacity-80 transition-opacity duration-150 ease-out-strong"
        >
          Try again
        </Link>
      </main>
      <DashboardFooter />
    </div>
  );
}

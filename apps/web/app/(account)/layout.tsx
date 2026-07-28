import { AccountContentTransition } from "@/components/account-content-transition";
import { AccountSidebar } from "@/components/account-sidebar";
import { getServerSession } from "@/lib/auth";
import { isOnboardingCompleteForWeb } from "@/lib/onboarding-status";

// Shared shell for the account tabs (Onboarding/Overview, Organization,
// Security, Billing) -- AccountSidebar mounts here once instead of once
// per page, so a client-side nav between tabs no longer unmounts and
// remounts it. That remount was the whole flicker bug: AccountSidebar's
// own onboarding-status fetch (lib/use-onboarding-status.ts) starts over
// from "unknown" on every mount, so the Overview link would drop out of
// the nav and pop back in on every single tab switch.
//
// Session and onboarding status are both resolved server-side and handed
// down as initial values, same reason initialSession already existed --
// no client-fetch flash on first paint either, not just after mount.
// Reuses lib/onboarding-status.ts's isOnboardingCompleteForWeb, the same
// no-network-hop check app/(account)/overview/page.tsx's own redirect
// gate uses, instead of a second implementation of "is onboarding done".
//
// Auth/entitlement redirects stay in each page, not here -- /overview's
// "bounce to /welcome if onboarding isn't done" and /welcome's own billing
// gate are page-specific, not something every tab under this layout needs.
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  const orgId = session?.session.activeOrganizationId;
  const initialOnboardingComplete = orgId ? await isOnboardingCompleteForWeb(orgId) : false;
  return (
    <div className="flex min-h-screen">
      <AccountSidebar initialSession={session ?? undefined} initialOnboardingComplete={initialOnboardingComplete} />
      {/* scrollbar-gutter: stable -- same reasoning as html's own rule in
          globals.css: this pane scrolls independently of the document, so
          that rule doesn't reach it. Overview is short, Billing (invoice
          table) and Organization (member list) can be tall enough to need
          a real scrollbar -- without reserving its width up front, tab-to-
          tab navigation visibly shifts everything sideways by the
          scrollbar's width every time a page crosses that threshold. */}
      <div className="flex flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable] lg:border-s lg:border-border">
        <AccountContentTransition>{children}</AccountContentTransition>
      </div>
    </div>
  );
}

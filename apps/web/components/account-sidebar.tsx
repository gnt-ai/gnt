"use client";

import Link from "next/link";
import { Menu } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { ThemeToggle } from "@/components/theme-toggle";
import { clearTwoFactorVerification } from "@/components/two-factor-gate";
import { authClient, useSession } from "@/lib/auth-client";
import { useOnboardingStatus } from "@/lib/use-onboarding-status";
import type { auth } from "@/lib/auth";

type ServerSession = Awaited<ReturnType<typeof auth.api.getSession>>;

const OVERVIEW_LINK = { href: "/overview", label: "Overview" };
const ONBOARDING_LINK = { href: "/welcome", label: "Onboarding" };

// Organization/Security/Billing are always there; the first slot swaps
// between Onboarding (not done yet) and Overview (done) -- see
// lib/use-onboarding-status.ts for the one source of truth on "done" that
// both this swap and app/(account)/overview/page.tsx's own server-side
// redirect gate share. Onboarding never lingers once Overview replaces
// it: there's nothing to show a "brain of the company" page for before
// gnt.ai has learned anything, and no reason to keep the setup checklist
// around once it's finished.
const NAV_LINKS = [
  { href: "/settings/organization", label: "Organization" },
  { href: "/settings/security", label: "Security" },
  { href: "/settings/billing", label: "Billing" },
];

function initials(name: string | undefined, email: string) {
  const source = name?.trim() || email;
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

// The shared shell for the signed-in account tabs -- welcome (Overview),
// settings/organization, settings/security, settings/billing. Mounted
// once by app/(account)/layout.tsx, not per page, so switching tabs never
// remounts (and never re-flashes) the sidebar. DashboardHeader is still
// used for the handful of non-tab account pages (billing/success,
// billing/cancel, onboarding/*) that aren't part of this nav. Nav links,
// sign-out, and the mobile checkbox-toggle pattern mirror its logic.
export function AccountSidebar({
  initialSession,
  initialOnboardingComplete,
}: {
  initialSession?: ServerSession;
  initialOnboardingComplete?: boolean;
}) {
  const { data: liveSession, isPending } = useSession();
  const knowsInitial = initialSession !== undefined;
  const session = isPending && knowsInitial ? initialSession : liveSession;
  const pathname = usePathname();
  const router = useRouter();
  // Not the same isPending-gated merge as session above: the live fetch
  // here hits apps/api, not this app's own server, so it can genuinely
  // fail (network hiccup, apps/api briefly down) and settle with
  // `loading: false, status: null` -- that's not "confirmed incomplete",
  // it's "unknown", and treating it as complete: false would flash
  // Onboarding back in over a correct server-computed Overview. Only a
  // real resolved status (from this fetch, whenever it lands) overrides
  // the initial value; loading or failed both keep deferring to it.
  const { status: liveOnboardingStatus, complete: liveOnboardingComplete } = useOnboardingStatus();
  const onboardingComplete = liveOnboardingStatus !== null ? liveOnboardingComplete : (initialOnboardingComplete ?? false);
  const navLinks = [onboardingComplete ? OVERVIEW_LINK : ONBOARDING_LINK, ...NAV_LINKS];

  async function handleSignOut() {
    clearTwoFactorVerification();
    await authClient.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <>
      <input type="checkbox" id="sidebar-toggle" className="peer sr-only" />

      <label
        htmlFor="sidebar-toggle"
        aria-hidden="true"
        className="fixed inset-0 z-30 hidden bg-shell/70 peer-checked:block lg:hidden"
      />

      <div
        id="dashboard-sidebar"
        className="fixed inset-y-0 start-0 z-40 flex w-64 -translate-x-full flex-col justify-between overflow-y-auto border-e border-border bg-shell transition-transform duration-300 ease-out-strong peer-checked:translate-x-0 lg:static lg:shrink-0 lg:translate-x-0"
      >
        <div className="p-4">
          <Link
            href="/welcome"
            className="inline-block font-mono text-sm font-bold tracking-tight hover:opacity-80 transition-opacity duration-150 ease-out-strong"
          >
            <span className="text-muted/50">[</span>gnt.ai<span className="text-muted/50">]</span>
          </Link>

          <nav aria-label="Account" className="mt-6">
            <ul className="space-y-1">
              {navLinks.map((link) => {
                const active = pathname === link.href;
                return (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      aria-current={active ? "page" : undefined}
                      className={
                        active
                          ? "block border-l-2 border-foreground bg-surface px-4 py-2 font-mono text-sm font-medium text-foreground"
                          : "block border-l-2 border-transparent px-4 py-2 font-mono text-sm font-medium text-muted transition-colors duration-150 ease-out-strong hover:border-border hover:bg-surface hover:text-foreground"
                      }
                    >
                      {link.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>

        <div className="sticky inset-x-0 bottom-0 border-t border-border bg-shell">
          <div className="flex items-center justify-between gap-2 px-4 py-3">
            <ThemeToggle />
          </div>
          {session && (
            <div className="flex items-center gap-3 border-t border-border p-4">
              <span
                aria-hidden="true"
                className="grid size-9 shrink-0 place-content-center rounded-[4px] bg-surface-high font-mono text-xs font-medium text-foreground"
              >
                {initials(session.user.name, session.user.email)}
              </span>
              <p className="min-w-0 font-mono text-xs text-foreground">
                <strong className="block truncate font-medium">{session.user.name || session.user.email}</strong>
                {session.user.name && <span className="block truncate text-muted">{session.user.email}</span>}
              </p>
              <button
                type="button"
                onClick={handleSignOut}
                className="ml-auto shrink-0 font-mono text-xs text-muted transition-colors duration-150 ease-out-strong hover:text-foreground"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export function AccountSidebarToggle() {
  return (
    <label
      htmlFor="sidebar-toggle"
      className="cursor-pointer rounded-[4px] p-2 text-muted transition-colors duration-150 ease-out-strong hover:bg-surface hover:text-foreground lg:hidden"
    >
      <span className="sr-only">Toggle menu</span>
      <Menu className="size-5" aria-hidden="true" />
    </label>
  );
}

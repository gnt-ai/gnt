"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ThemeToggle } from "@/components/theme-toggle";
import { clearTwoFactorVerification } from "@/components/two-factor-gate";
import { authClient, useSession } from "@/lib/auth-client";
import type { auth } from "@/lib/auth";

type ServerSession = Awaited<ReturnType<typeof auth.api.getSession>>;

const NAV_LINKS = [
  { href: "/welcome", label: "Overview" },
  { href: "/settings/organization", label: "Organization" },
  { href: "/settings/security", label: "Security" },
  { href: "/settings/billing", label: "Billing" },
];

// Chrome for signed-in account pages -- deliberately not MarketingHeader.
// gnt.ai is CLI-first (see welcome/page.tsx's own copy: "the real work
// happens in your terminal, not here"), so these pages are account
// management, not the product, and shouldn't wear the public site's
// header. Nav links stay
// always visible, never behind `hidden sm:inline` the way MarketingHeader
// hides Docs/Pricing/Changelog on mobile -- with only four short links
// and nowhere else to put them, hiding any would leave phone users with
// no way to move between dashboard sections. overflow-x-auto instead,
// same scroll-not-wrap pattern docs-tabs.tsx already uses for its own
// sub-nav.
export function DashboardHeader({ initialSession }: { initialSession?: ServerSession }) {
  const { data: liveSession, isPending } = useSession();
  const knowsInitial = initialSession !== undefined;
  const session = isPending && knowsInitial ? initialSession : liveSession;
  const pathname = usePathname();
  const router = useRouter();

  async function handleSignOut() {
    // Same ordering as MarketingHeader's handleSignOut -- see
    // clearTwoFactorVerification's own comment for why this has to run
    // before the session goes away, not after.
    clearTwoFactorVerification();
    await authClient.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <header className="flex justify-center border-b border-border">
      <div className="flex h-14 items-center gap-6 px-6 max-w-3xl w-full sm:border-x sm:border-border">
        <Link
          href="/welcome"
          className="shrink-0 font-mono text-sm font-bold tracking-tight hover:opacity-80 transition-opacity duration-150 ease-out-strong"
        >
          <span className="text-muted/50">[</span>gnt.ai<span className="text-muted/50">]</span>
        </Link>
        <nav className="flex items-center gap-5 overflow-x-auto">
          {NAV_LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "shrink-0 whitespace-nowrap font-mono text-sm font-medium text-foreground transition-colors duration-150 ease-out-strong"
                    : "shrink-0 whitespace-nowrap font-mono text-sm font-medium text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
                }
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-3 shrink-0 ml-auto">
          <ThemeToggle />
          {session && (
            <button
              type="button"
              onClick={handleSignOut}
              className="inline-flex items-center rounded-[4px] border border-border px-4 py-1 font-mono text-sm font-medium leading-[2] text-foreground hover:border-foreground/30 transition-colors duration-150 ease-out-strong"
            >
              Sign out
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

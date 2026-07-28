"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ThemeToggle } from "@/components/theme-toggle";
import { clearTwoFactorVerification } from "@/components/two-factor-gate";
import { authClient, useSession } from "@/lib/auth-client";
import type { auth } from "@/lib/auth";

type ServerSession = Awaited<ReturnType<typeof auth.api.getSession>>;

// Chrome for the account/billing setup steps -- deliberately neither
// MarketingHeader (public-site nav doesn't apply once you're signed in)
// nor DashboardHeader (its Overview/Organization/Security/Billing nav
// assumes an org and a plan already exist, neither of which is true yet
// mid-onboarding -- those links would either 404 or bounce straight back
// here). Just the wordmark and a way to bail, same restrained "nothing to
// navigate to yet" posture as a signup wizard, not the full account shell.
export function OnboardingHeader({ initialSession }: { initialSession?: ServerSession }) {
  const { data: liveSession, isPending } = useSession();
  const knowsInitial = initialSession !== undefined;
  const session = isPending && knowsInitial ? initialSession : liveSession;
  const router = useRouter();

  async function handleSignOut() {
    clearTwoFactorVerification();
    await authClient.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <header className="flex justify-center border-b border-border">
      <div className="flex h-14 items-center justify-between px-6 max-w-3xl w-full sm:border-x sm:border-border">
        <Link
          href="/"
          className="font-mono text-sm font-bold tracking-tight hover:opacity-80 transition-opacity duration-150 ease-out-strong"
        >
          <span className="text-muted/50">[</span>gnt.ai<span className="text-muted/50">]</span>
        </Link>
        <div className="flex items-center gap-3">
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

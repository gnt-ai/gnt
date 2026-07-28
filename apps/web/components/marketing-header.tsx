"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ThemeToggle } from "@/components/theme-toggle";
import { clearTwoFactorVerification } from "@/components/two-factor-gate";
import { authClient, useSession } from "@/lib/auth-client";

// primary-nav from the OpenCode reference doc: ASCII wordmark at left,
// link cluster center-right, a solid button-primary CTA at the far right,
// 56px height, 1px hairline bottom rule, rounded.none throughout. Same
// max-w-3xl + sm:border-x as the page frame below it (see <Section> in
// page.tsx) -- the vertical hairlines have to run continuously through
// the nav, not start only where the content sections begin. border-x is
// dropped below sm: on every page that uses this frame -- at mobile
// widths the column is already nearly full-bleed, so the hairlines are
// just clutter there.
export function MarketingHeader() {
  // No initialSession prop -- every one of this header's 11 callers is
  // either a client component or a server one that never actually passes
  // it, so the "unknown state, show a blank skeleton" branch this used to
  // have was live on literally every page load: Sign in/Sign up sat
  // invisible for however long useSession()'s own fetch took, then
  // popped in. Rendering optimistically as signed-out the instant this
  // mounts (session starts undefined, same falsy behavior as null) costs
  // an already-signed-in visitor a sub-200ms flash of the wrong buttons
  // instead -- a real trade, but a much smaller and rarer one than
  // blanking the button entirely for every visitor on every page.
  const { data: session } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  // On mobile, only the solid button is visible (the text link next to it
  // is hidden sm:inline) -- always pointing that button at "Sign in" meant
  // the one visible auth CTA on /sign-in itself was "Sign in" again,
  // pointless since you're already there. On either auth page, offer only
  // the opposite action (as the one solid button, no second redundant
  // link) instead of the default Sign up (text) + Sign in (button) pair
  // every other page still shows. /cli-login embeds the same sign-in form
  // (see cli-login-client.tsx's signed-out state) so it gets the same
  // treatment as /sign-in.
  const onAuthPage = pathname === "/sign-in" || pathname === "/sign-up" || pathname === "/cli-login";
  // On an auth page, the button offers the opposite of whichever one this
  // is. Everywhere else, the button is always "Sign in" -- "Sign up" is
  // the separate text link right next to it (see !onAuthPage below). This
  // used to default to "Sign up" whenever pathname wasn't exactly
  // "/sign-up", which was only ever correct for /sign-up and /sign-in
  // themselves -- every normal page fell through to that same default and
  // rendered "Sign up" as both the text link and the button.
  const primaryAuth = onAuthPage
    ? pathname === "/sign-up"
      ? { href: "/sign-in", label: "Sign in" }
      : { href: "/sign-up", label: "Sign up" }
    : { href: "/sign-in", label: "Sign in" };

  async function handleSignOut() {
    // Before the session goes away, not after -- see the function comment
    // on clearTwoFactorVerification for why this has to happen at all
    // (sessionStorage otherwise survives sign-out in the same tab).
    clearTwoFactorVerification();
    await authClient.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <header className="flex justify-center border-b border-border">
      <div className="flex h-14 items-center justify-between gap-4 px-6 max-w-3xl w-full sm:border-x sm:border-border">
        <Link
          href="/"
          className="font-mono text-sm font-bold tracking-tight hover:opacity-80 transition-opacity duration-150 ease-out-strong"
        >
          {/* .pixel-text's dot-mask only reads as a wordmark at the hero's
              large scale (see page.tsx) -- at nav size the same fixed 4px/
              7px mask stops just look like noise, so this stays plain
              bold text instead of forcing the same treatment twice. */}
          <span className="text-muted/50">[</span>gnt.ai<span className="text-muted/50">]</span>
        </Link>
        <nav className="flex items-center gap-4 sm:gap-3.5">
          <Link
            href="/docs"
            className="hidden sm:inline font-mono text-sm font-medium text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
          >
            Docs
          </Link>
          <Link
            href="/pricing"
            className="hidden sm:inline font-mono text-sm font-medium text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
          >
            Pricing
          </Link>
          <Link
            href="/changelog"
            className="hidden sm:inline font-mono text-sm font-medium text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
          >
            Changelog
          </Link>
          <Link
            href="https://github.com/gnt-ai/gnt"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:inline font-mono text-sm font-medium text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
          >
            GitHub
          </Link>
          <ThemeToggle />
          {/* Fixed-width, right-aligned reservation for whichever of the
              three states below ends up rendering (nothing yet, signed
              out, or signed in) -- signed-in content (Organization +
              Security + Sign out, ~325px) is a lot wider than signed-out
              (Sign up + Sign in, ~182px) on desktop, and "Sign out" alone
              is a little wider than "Sign in" on mobile too. Without a
              shared reservation, Docs/Pricing/Changelog/the theme toggle
              would all visibly shift left or right as this area resized
              once the real session resolved -- measured live, an ~140px
              jump on desktop. min-w here covers the widest real case at
              each breakpoint so nothing ever moves regardless of which
              state wins; justify-end keeps a narrower state's content
              hugging the same right edge instead of drifting. */}
          <div className="flex items-center gap-4 sm:gap-6 justify-end min-w-[112px] sm:min-w-[330px]">
            {!session && (
              <>
                {!onAuthPage && (
                  <Link
                    href="/sign-up"
                    className="hidden sm:inline font-mono text-sm font-medium text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
                  >
                    Sign up
                  </Link>
                )}
                <Link
                  href={primaryAuth.href}
                  className="inline-flex items-center rounded-[4px] bg-accent-brand px-5 py-1 font-mono text-sm font-medium leading-[2] text-accent-brand-foreground hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong"
                >
                  {primaryAuth.label}
                </Link>
              </>
            )}
            {session && (
              <>
                <Link
                  href="/settings/organization"
                  className="hidden sm:inline font-mono text-sm font-medium text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
                >
                  Organization
                </Link>
                <Link
                  href="/settings/security"
                  className="hidden sm:inline font-mono text-sm font-medium text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
                >
                  Security
                </Link>
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="inline-flex items-center rounded-[4px] border border-border px-5 py-1 font-mono text-sm font-medium leading-[2] text-foreground hover:border-foreground/30 transition-colors duration-150 ease-out-strong"
                >
                  Sign out
                </button>
              </>
            )}
          </div>
        </nav>
      </div>
    </header>
  );
}

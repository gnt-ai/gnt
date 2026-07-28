"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";

function verifiedKey(userId: string): string {
  return `gnt-2fa-verified:${userId}`;
}

// Marks the browser as having passed a TOTP challenge for this user --
// called by app/verify-2fa/page.tsx on success. localStorage (not
// sessionStorage): a fresh tab used to re-trigger the challenge every time
// because sessionStorage is scoped per-tab, which was more re-prompting
// than the security model actually calls for -- the flag already dies on
// sign-out (below) and on browser-profile-level clears, so tab-scoping it
// on top of that was just friction, not a real second gate. See
// lib/auth-client.ts's comment on why the trustDevice option isn't wired
// up here.
export function markTwoFactorVerified(userId: string) {
  try {
    localStorage.setItem(verifiedKey(userId), "1");
  } catch {
    // Private-browsing localStorage denial or similar -- worst case this
    // tab re-prompts for a code on the next gated page, not a security hole.
  }
}

// Shared by any page that needs to make its own routing decision before
// TwoFactorGate's own effect would get a chance to run -- app/cli-login/
// page.tsx mints an admin-capable credential in the same effect that
// checks the session, so it can't wait out a race against a second,
// separately-mounted component's effect to decide whether to redirect
// first. Fails toward "not verified" (re-prompt) on any storage error,
// same posture as the gate itself.
export function isTwoFactorVerified(userId: string): boolean {
  try {
    return localStorage.getItem(verifiedKey(userId)) === "1";
  } catch {
    return false;
  }
}

// Called by components/marketing-header.tsx's handleSignOut, right before
// signing out. localStorage otherwise outlives sign-out -- caught this
// live (back when this was sessionStorage): signing out and back in as the
// same user in the same tab skipped the TOTP challenge entirely, because
// markTwoFactorVerified's flag from the earlier session was still sitting
// there. Clears every account's flag, not just the signed-out one --
// sign-out is exactly the moment this browser stops representing any
// verified session.
export function clearTwoFactorVerification() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith("gnt-2fa-verified:")) localStorage.removeItem(key);
    }
  } catch {
    // Same fail-open-to-re-prompt posture as everywhere else here.
  }
}

// better-auth's own twoFactor plugin only intercepts /sign-in/email,
// /sign-in/username, and /sign-in/phone-number (confirmed in its installed
// source) -- this app signs in exclusively via email OTP and OAuth, neither
// of which the plugin gates, so a 2FA-enabled account still lands in a
// real, fully authenticated session the instant OTP/OAuth completes. This
// component is the application-level backstop for that gap: mounted on
// every page reachable right after sign-in (welcome, cli-login,
// settings/security), it bounces anyone whose account has 2FA enabled but
// hasn't cleared a TOTP challenge yet in this tab to /verify-2fa before
// rendering anything else. The challenge itself still goes through
// better-auth's real /two-factor/verify-totp endpoint (see
// app/verify-2fa/page.tsx) -- this only decides *whether* to send someone
// there, it never checks a code itself.
export function TwoFactorGate() {
  const { data: session, isPending } = useSession();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (isPending || !session) return;
    if (!session.user.twoFactorEnabled) return;
    if (isTwoFactorVerified(session.user.id)) return;
    router.replace(`/verify-2fa?next=${encodeURIComponent(pathname)}`);
  }, [isPending, session, pathname, router]);

  return null;
}

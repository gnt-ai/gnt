import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Protected-list, not public-list -- an allowlist of public routes meant
// "protect everything else" also protected genuinely nonexistent routes,
// since this runs before Next resolves whether a page exists at all. That
// sent anonymous visitors hitting a typo'd URL to a login wall instead of
// app/not-found.tsx. Only these routes actually need a session
// (onboarding/organization is the org-creation step every brand-new signup
// needs; accept-invitation needs a signed-in user to attach the invitation
// to; settings is account/security management; verify-2fa is the
// mid-sign-in TOTP challenge -- see components/two-factor-gate.tsx, the
// only thing that ever links here) -- everything else, including a bogus
// path, falls through to Next's normal routing/404 handling.
//
// cli-login is deliberately NOT here even though it also mints a CLI
// token: unlike the others, a visit with no session cookie is an expected
// case for it (a brand-new signup, or `gnt login` opening a browser
// context that's never signed in), not a wrong turn -- and it carries a
// `?callback=` query param a bare /sign-in redirect would strip. The page
// itself renders an inline sign-in form for that case (see
// components/cli-login-client.tsx) that keeps the callback intact through
// the sign-in round trip, which a middleware-level redirect can't do.
//
// Cookie-presence only, not a real DB-validated session check -- this is
// Better Auth's own documented recommendation for proxy/middleware (avoid
// blocking every request on a DB round trip); each protected page does its
// own real check via useSession()/auth.api.getSession() if it needs one.
// For accept-invitation specifically, a signed-out visitor redirected to
// /sign-in loses the invitation id from the URL entirely (same detour
// cli-login/onboarding already document) -- the page's own signed-out
// branch tells them to reopen the emailed link once they're in, matching
// that existing pattern rather than threading a return-to param through.
const PROTECTED_PREFIXES = ["/onboarding", "/accept-invitation", "/settings", "/verify-2fa"];

function isProtectedRoute(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function proxy(request: NextRequest) {
  if (!isProtectedRoute(request.nextUrl.pathname)) {
    return NextResponse.next();
  }
  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    const signIn = new URL("/sign-in", request.url);
    return NextResponse.redirect(signIn);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};

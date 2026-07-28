"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthScreen } from "@/components/auth-screen";
import { MarketingHeader } from "@/components/marketing-header";
import { isTwoFactorVerified } from "@/components/two-factor-gate";
import { API_URL } from "@/lib/api-url";
import { authClient, useSession } from "@/lib/auth-client";
import { checkBillingRedirect } from "@/lib/billing-gate-logic";

// "no-login-id" and "signed-out" are their own states, not folded into
// "error" -- both are expected, recoverable situations (visited directly
// with no CLI session waiting; or `gnt login` opened a browser context
// that isn't signed in yet, which happens for a brand-new signup and for
// an agent driving its own browser profile) and each has its own way
// forward. "error" stays for genuine failures partway through actually
// minting the key.
type Status = "working" | "done" | "error" | "no-login-id" | "signed-out";

const LOGIN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isValidLoginId(raw: string | null): raw is string {
  return raw !== null && LOGIN_ID_PATTERN.test(raw);
}

export function CliLoginClient({
  providers,
  emailConfigured,
}: {
  providers: { google: boolean; github: boolean };
  emailConfigured: boolean;
}) {
  const { data: session, isPending } = useSession();
  const [status, setStatus] = useState<Status>("working");
  const started = useRef(false);
  const router = useRouter();

  useEffect(() => {
    // Session hasn't finished loading yet — calling token() before this
    // can resolve against a stale/absent session, which is exactly what
    // caused every mcp-keys request to come back 401 the first time this
    // ran under Clerk's equivalent getToken().
    if (isPending) return;

    // The cli-key this page mints carries the signed-in human's own admin
    // status (see create_cli_key's docstring in
    // apps/api/src/gnt/routers/settings.py) -- the single most
    // security-sensitive action the web app exposes, so it's checked
    // inline here rather than trusting a separately-mounted
    // components/two-factor-gate.tsx to redirect first. Both run off the
    // same session load and would otherwise race: this effect could mint
    // the key before the gate's own effect got a chance to navigate away.
    if (session?.user.twoFactorEnabled && !isTwoFactorVerified(session.user.id)) {
      router.replace(`/verify-2fa?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }

    // React (StrictMode, or Fast Refresh in dev) can fire this effect more
    // than once — guard so a double-fire doesn't mint two keys. Only set
    // once we're actually about to mint (inside run(), below), so the
    // no-login-id/signed-out branches can keep re-running harmlessly.
    if (started.current) return;

    async function run() {
      const loginId = new URLSearchParams(window.location.search).get("login_id");
      if (!isValidLoginId(loginId)) {
        setStatus("no-login-id");
        return;
      }

      // No session yet isn't a failure — `gnt login` can land here from a
      // browser context that was never signed in (a brand-new signup, or
      // an agent driving its own browser profile separate from the user's
      // regular one). Show a sign-in form right here instead of
      // dead-ending; once `session` flips from null to real, this effect
      // reruns and falls through to the mint flow below.
      if (!session) {
        setStatus("signed-out");
        return;
      }

      started.current = true;
      setStatus("working");
      await finish(loginId);
    }

    async function finish(loginId: string) {
      try {
        const { data, error: tokenError } = await authClient.token();
        const token = data?.token;
        if (tokenError || !token) {
          console.error("cli-login: token() returned no token for a signed-in session", tokenError);
          setStatus("error");
          return;
        }
        // cli-key, not mcp-keys — this mints a personal credential that
        // carries the signed-in user's own admin status (needed for `gnt
        // review`'s approve/reject calls), gated on this being a real
        // session rather than another API key. See
        // apps/api/src/gnt/routers/settings.py's create_cli_key. login_id
        // has the API stash the minted key in Redis for the CLI's own
        // /v1/settings/cli-key/poll to pick up -- gnt login polls instead
        // of running a local server this page posts back to, since Chrome
        // now gates a public https page fetching a loopback address
        // behind a permission prompt nothing here can satisfy.
        const res = await fetch(`${API_URL}/v1/settings/cli-key`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ login_id: loginId }),
        });
        if (!res.ok) {
          // A brand-new signup has a session but no org yet (get_current_org
          // 403s with "no active organization on session" -- see
          // apps/api/src/gnt/auth/better_auth.py) until they've named their
          // organization. Send them to do that, then straight back here
          // instead of dead-ending -- same round-trip shape as the
          // signed-out branch above.
          if (res.status === 403) {
            router.push(`/onboarding/organization?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
            return;
          }
          console.error(`cli-login: cli-key request failed (${res.status})`);
          setStatus("error");
          return;
        }
        // The CLI already has its key at this point (or is about to, on
        // its next poll) -- `gnt` in the terminal can proceed regardless
        // of what happens next in this tab. But the human sitting in the
        // browser hasn't necessarily started a trial yet, so send them to
        // billing instead of just saying "done" and leaving them nowhere,
        // same gate the web sign-up flow already enforces.
        const shouldRedirect = await checkBillingRedirect(() =>
          fetch(`${API_URL}/v1/billing/status`, { headers: { Authorization: `Bearer ${token}` } }),
        );
        if (shouldRedirect) {
          router.push("/onboarding/billing");
          return;
        }
        setStatus("done");
      } catch (err) {
        console.error("cli-login: unexpected error", err);
        setStatus("error");
      }
    }

    run();
  }, [isPending, session, router]);

  return (
    <div className="flex-1 flex flex-col">
      <MarketingHeader />
      <main className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-3">
        {status === "working" && <p className="font-mono text-sm text-muted">Connecting…</p>}
        {status === "done" && (
          <p className="font-mono text-sm text-foreground">Connected. Return to your terminal.</p>
        )}
        {status === "signed-out" && (
          <div className="w-full max-w-[420px] flex flex-col items-center gap-4">
            {/* AuthScreen's own root is w-full max-w-[420px] -- without
                this same explicit width on the wrapper, a flex-col parent
                with no definite cross-axis size resolves that w-full
                against the narrower sibling <p>'s own shrink-to-fit width
                instead (measured live: the card rendered at 302px here vs
                420px on the real /sign-in page, same AuthScreen component
                both times). Giving the wrapper the identical max-w removes
                the ambiguity instead of guessing at a fix. */}
            <p className="font-mono text-sm text-muted max-w-sm">
              Sign in to connect the CLI.
            </p>
            <AuthScreen
              mode="sign-in"
              providers={providers}
              emailConfigured={emailConfigured}
              postAuthRedirect={window.location.pathname + window.location.search}
            />
          </div>
        )}
        {status === "no-login-id" && (
          <div className="flex flex-col items-center gap-2 max-w-sm">
            <p className="font-mono text-sm text-foreground">
              No CLI session waiting to connect.
            </p>
            <p className="font-mono text-sm text-muted">
              This page is meant to be opened by{" "}
              <code className="text-foreground">gnt login</code> running in your terminal, not
              visited directly.
            </p>
            <Link
              href="/welcome"
              className="font-mono text-sm text-foreground underline hover:opacity-80 transition-opacity duration-150 ease-out-strong"
            >
              Go to your account
            </Link>
          </div>
        )}
        {status === "error" && (
          <p className="font-mono text-sm text-muted max-w-sm">
            Something went wrong connecting the CLI. Close this tab and try{" "}
            <code className="text-foreground">gnt login</code> again.
          </p>
        )}
      </main>
    </div>
  );
}

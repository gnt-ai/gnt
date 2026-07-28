"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient, useSession } from "@/lib/auth-client";

type Step = "email" | "code";
type OAuthProvider = "google" | "github";

// Purely a client-side throttle on the button itself -- the real spam
// backstop is the server-side rateLimit on emailOTP in lib/auth.ts (8 sends
// per 10 minutes, shared across this button and a fresh "Continue with
// email" submit). This just stops someone from mashing the button a dozen
// times in the first few seconds, which would otherwise burn most of that
// budget before the first code has even had a chance to arrive.
const RESEND_COOLDOWN_SECONDS = 30;

const COPY = {
  "sign-in": { heading: "Sign in", subhead: "Pick up where you left off." },
  "sign-up": { heading: "Get started", subhead: "No password to create or remember." },
} as const;

// The other mode is one click away regardless of which one you landed on
// -- no password to reset means "wrong page" has no other recovery path
// than backing out to the homepage and finding the right link again.
const SWITCH = {
  "sign-in": { prompt: "Don’t have an account?", label: "Sign up", href: "/sign-up" },
  "sign-up": { prompt: "Already have an account?", label: "Sign in", href: "/sign-in" },
} as const;

// Every successful auth (OAuth callback, OTP verify) lands here first, not
// straight at /welcome — sign-in and sign-up are now the same request
// (email OTP auto-registers a new user transparently, see lib/auth.ts), so
// nothing on this side knows ahead of time whether the org-creation step
// is needed. onboarding/organization/page.tsx does that check itself and
// skips straight to /welcome for anyone who already has an active org.
const POST_AUTH_REDIRECT = "/onboarding/organization";

// activeOrganizationId lives on the *session* row, not the user -- every
// fresh sign-in mints a brand-new session, so even a long-time member's
// session starts with it unset (confirmed against a real sign-in: GET
// /get-session right after verify came back activeOrganizationId: null
// for an existing, already-orged user). There's no "restore my last org"
// call of its own, only organization.list() + setActive() -- which is
// exactly what onboarding/organization/page.tsx's own client component
// (onboarding-organization-client.tsx) already does, just after a full
// extra page load. Doing that same list+setActive here first, before
// ever navigating, and going straight to /welcome on success (its own
// gate still catches an unpaid org, see app/(account)/welcome/page.tsx)
// collapses that page load out of the common existing-user path entirely
// instead of just making it faster. Only attempted for the *default*
// destination -- /cli-login passes its own postAuthRedirect (back to
// itself) and re-checks billing on its own, so it always falls straight
// through unchanged. A brand-new sign-up (list() comes back empty) also
// falls through unchanged: that page is genuinely where org creation
// happens. OAuth isn't wired through this at all -- callbackURL has to be
// picked before the provider round trip, before there's any JS control
// back in this component to run it from; that path still lands on
// /onboarding/organization and pays for the page load.
async function destinationAfterAuth(
  postAuthRedirect: string,
  activeOrganizationId: string | null | undefined,
): Promise<string> {
  if (postAuthRedirect !== POST_AUTH_REDIRECT) return postAuthRedirect;
  if (activeOrganizationId) return "/welcome";
  const { data: orgs } = await authClient.organization.list();
  if (!orgs || orgs.length === 0) return postAuthRedirect;
  const { error } = await authClient.organization.setActive({ organizationId: orgs[0].id });
  return error ? postAuthRedirect : "/welcome";
}

export function AuthScreen({
  mode,
  providers,
  emailConfigured,
  postAuthRedirect = POST_AUTH_REDIRECT,
}: {
  mode: "sign-in" | "sign-up";
  providers: { google: boolean; github: boolean };
  emailConfigured: boolean;
  // /cli-login overrides this to bounce back to itself (callback param and
  // all) instead of the default onboarding destination -- see that page for
  // why finishing a CLI connection needs to survive a sign-in round trip.
  postAuthRedirect?: string;
}) {
  const router = useRouter();
  const { data: session, isPending: sessionPending } = useSession();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [oauthPending, setOauthPending] = useState<OAuthProvider | null>(null);
  const [resending, setResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendNotice, setResendNotice] = useState(false);

  const copy = COPY[mode];
  const switchCopy = SWITCH[mode];
  const anyOAuth = providers.google || providers.github;

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => setResendCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  // Landing on /sign-in or /sign-up while already signed in (e.g. clicking
  // "Start free trial" from the homepage in a tab that's already
  // authenticated) used to just show the auth form again with no sign it
  // recognized you -- bounce straight to the signed-in landing spot
  // instead, same destination a fresh sign-in/sign-up would end up at.
  useEffect(() => {
    if (sessionPending || !session) return;
    let cancelled = false;
    destinationAfterAuth(postAuthRedirect, session.session.activeOrganizationId).then((destination) => {
      if (!cancelled) router.replace(destination);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionPending, session, router, postAuthRedirect]);

  async function handleOAuth(provider: OAuthProvider) {
    setError(null);
    setOauthPending(provider);
    const { error: oauthError } = await authClient.signIn.social({
      provider,
      callbackURL: postAuthRedirect,
    });
    if (oauthError) {
      setOauthPending(null);
      setError(oauthError.message ?? `Couldn't start sign-in with ${provider}.`);
    }
    // On success this navigates away to the provider — no further state to set.
  }

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSending(true);
    const { error: sendError } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "sign-in",
    });
    setSending(false);
    if (sendError) {
      setError(sendError.message ?? "Couldn't send a code. Check the address and try again.");
      return;
    }
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
    setStep("code");
  }

  async function handleResendCode() {
    setError(null);
    setResendNotice(false);
    setResending(true);
    const { error: sendError } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "sign-in",
    });
    setResending(false);
    if (sendError) {
      setError(sendError.message ?? "Couldn't resend the code. Try again in a moment.");
      return;
    }
    setCode("");
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
    setResendNotice(true);
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setVerifying(true);
    const { error: verifyError } = await authClient.signIn.emailOtp({ email, otp: code });
    if (verifyError) {
      setVerifying(false);
      setError(verifyError.message ?? "That code didn't work. Check it and try again.");
      return;
    }
    // A session this fresh never has activeOrganizationId set yet (see
    // destinationAfterAuth's own comment) -- skip straight to the
    // list+setActive attempt instead of a get-session round trip that
    // would only ever come back null here.
    const destination = await destinationAfterAuth(postAuthRedirect, null);
    setVerifying(false);
    router.push(destination);
  }

  // Covers both the brief session-load flash and the already-signed-in
  // redirect above -- neither should show the auth form for even a frame.
  if (sessionPending || session) {
    return (
      <div className="w-full max-w-[420px] border border-border bg-surface">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <div aria-hidden="true" className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-surface-highest" />
            <span className="h-2.5 w-2.5 rounded-full bg-surface-highest" />
            <span className="h-2.5 w-2.5 rounded-full bg-surface-highest" />
          </div>
          <span className="font-mono text-xs uppercase tracking-widest text-muted">gnt auth</span>
        </div>
        <div className="p-6">
          <p className="font-mono text-sm text-muted">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[420px] border border-border bg-surface">
      {/* Same window chrome as TerminalBlock (components/terminal-block.tsx)
          — three dots, hairline-bordered header — minus the copy button,
          which doesn't apply here. Reusing the classnames directly rather
          than the component itself since TerminalBlock is purpose-built
          around copyable command output. */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div aria-hidden="true" className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-surface-highest" />
          <span className="h-2.5 w-2.5 rounded-full bg-surface-highest" />
          <span className="h-2.5 w-2.5 rounded-full bg-surface-highest" />
        </div>
        <span className="font-mono text-xs uppercase tracking-widest text-muted">gnt auth</span>
      </div>

      <div className="p-6 flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h1 className="font-mono font-bold tracking-tight text-foreground text-lg">{copy.heading}</h1>
          <p className="font-mono text-sm text-muted">{copy.subhead}</p>
        </div>

        {mode === "sign-up" && (
          <p className="font-mono text-xs text-muted leading-relaxed">
            By continuing, you agree to gnt.ai&rsquo;s{" "}
            <Link href="/terms" className="underline hover:text-foreground">
              Terms
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="underline hover:text-foreground">
              Privacy Policy
            </Link>
            .
          </p>
        )}

        {step === "email" && (
          <>
            {anyOAuth && (
              <div className="flex flex-col gap-2">
                {providers.github && (
                  <button
                    type="button"
                    onClick={() => handleOAuth("github")}
                    disabled={oauthPending !== null}
                    className="rounded-[4px] border border-border bg-surface text-foreground font-mono text-sm font-medium py-2 hover:border-foreground/40 transition-colors duration-150 ease-out-strong disabled:opacity-50"
                  >
                    {oauthPending === "github" ? "Redirecting..." : "Continue with GitHub"}
                  </button>
                )}
                {providers.google && (
                  <button
                    type="button"
                    onClick={() => handleOAuth("google")}
                    disabled={oauthPending !== null}
                    className="rounded-[4px] border border-border bg-surface text-foreground font-mono text-sm font-medium py-2 hover:border-foreground/40 transition-colors duration-150 ease-out-strong disabled:opacity-50"
                  >
                    {oauthPending === "google" ? "Redirecting..." : "Continue with Google"}
                  </button>
                )}
              </div>
            )}

            {anyOAuth && (
              <div className="flex items-center gap-3" aria-hidden="true">
                <span className="h-px flex-1 bg-border" />
                <span className="font-mono text-xs uppercase tracking-widest text-muted">or</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            )}

            <form onSubmit={handleSendCode} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="email" className="font-mono text-xs uppercase tracking-widest text-muted">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  autoFocus={!anyOAuth}
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="rounded-[4px] bg-surface-low border border-border text-foreground placeholder:text-muted/50 focus:border-foreground/40 transition-colors duration-150 ease-out-strong px-3 py-2 text-sm outline-none"
                />
              </div>

              {error && <p className="text-sm text-error">{error}</p>}

              <button
                type="submit"
                disabled={sending || oauthPending !== null}
                className="rounded-[4px] bg-accent-brand text-accent-brand-foreground font-mono text-sm font-medium hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong py-2 disabled:opacity-50"
              >
                {sending ? "Sending code..." : "Continue with email"}
              </button>
            </form>
          </>
        )}

        {step === "code" && (
          <form onSubmit={handleVerifyCode} className="flex flex-col gap-3">
            <p className="font-mono text-sm text-muted">
              Code sent to <span className="text-foreground">{email}</span>.
            </p>
            {resendNotice && (
              <p className="font-mono text-sm text-foreground">New code sent.</p>
            )}
            {!emailConfigured && (
              <p className="font-mono text-xs text-muted border border-border bg-surface-low px-3 py-2">
                Dev mode: no email provider configured. Check the server terminal for the code.
              </p>
            )}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="otp" className="font-mono text-xs uppercase tracking-widest text-muted">
                6-digit code
              </label>
              <input
                id="otp"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                required
                autoFocus
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="rounded-[4px] bg-surface-low border border-border text-foreground placeholder:text-muted/50 focus:border-foreground/40 transition-colors duration-150 ease-out-strong px-3 py-2 text-sm tracking-[0.5em] text-center outline-none"
              />
            </div>

            {error && <p className="text-sm text-error">{error}</p>}

            <button
              type="submit"
              disabled={verifying || code.length !== 6}
              className="rounded-[4px] bg-accent-brand text-accent-brand-foreground font-mono text-sm font-medium hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong py-2 disabled:opacity-50"
            >
              {verifying ? "Verifying..." : "Verify code"}
            </button>

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={handleResendCode}
                disabled={resending || resendCooldown > 0}
                className="font-mono text-sm text-muted hover:text-foreground transition-colors duration-150 ease-out-strong disabled:opacity-50"
              >
                {resending
                  ? "Resending..."
                  : resendCooldown > 0
                    ? `Resend code (${resendCooldown}s)`
                    : "Resend code"}
              </button>

              <button
                type="button"
                onClick={() => {
                  setStep("email");
                  setCode("");
                  setError(null);
                  setResendNotice(false);
                }}
                className="font-mono text-sm text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
              >
                Use a different email
              </button>
            </div>
          </form>
        )}

        <p className="font-mono text-sm text-muted text-center">
          {switchCopy.prompt}{" "}
          <Link
            href={switchCopy.href}
            className="text-foreground underline hover:opacity-80 transition-opacity duration-150 ease-out-strong"
          >
            {switchCopy.label}
          </Link>
        </p>
      </div>
    </div>
  );
}

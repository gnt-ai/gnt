"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MarketingHeader } from "@/components/marketing-header";
import { markTwoFactorVerified } from "@/components/two-factor-gate";
import { authClient, useSession } from "@/lib/auth-client";

const DEFAULT_NEXT = "/welcome";

// Only ever a same-site path -- an absolute or protocol-relative "next"
// would be an open redirect off the back of a security-sensitive page.
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return DEFAULT_NEXT;
  return raw;
}

type Method = "totp" | "backup";

// The mid-sign-in TOTP challenge -- see components/two-factor-gate.tsx for
// why this exists as its own page instead of relying on better-auth's
// built-in twoFactorRedirect flow (that flow never fires for this app's
// sign-in methods). By the time someone lands here they already have a
// real session (OTP/OAuth already completed) -- this page's only job is to
// confirm they also control the authenticator app before the gate lets
// them through. authClient.twoFactor.verifyTotp/verifyBackupCode still do
// the real work: checked better-auth's own source and both endpoints
// validate the submitted code against the signed-in session's user even
// when a full session already exists, not only via the pre-session cookie
// path the built-in redirect uses.
function VerifyTwoFactorForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const { data: session, isPending } = useSession();

  const [method, setMethod] = useState<Method>("totp");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!session) return;
    setError(null);
    setVerifying(true);
    const { error: verifyError } =
      method === "totp"
        ? await authClient.twoFactor.verifyTotp({ code })
        : await authClient.twoFactor.verifyBackupCode({ code });
    setVerifying(false);
    if (verifyError) {
      setError(
        method === "totp"
          ? "That code didn't work. Check it and try again."
          : "That backup code didn't work. Check it and try again.",
      );
      return;
    }
    markTwoFactorVerified(session.user.id);
    router.push(next);
  }

  if (isPending) {
    return <p className="font-mono text-sm text-muted">Loading…</p>;
  }

  // Not signed in at all, or 2FA isn't actually on -- nothing to verify,
  // send them somewhere sane instead of showing a code form with no
  // account behind it.
  if (!session) {
    router.replace("/sign-in");
    return null;
  }
  if (!session.user.twoFactorEnabled) {
    router.replace(next);
    return null;
  }

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

      <div className="p-6 flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h1 className="font-mono font-bold tracking-tight text-foreground text-lg">
            Two-factor verification
          </h1>
          <p className="font-mono text-sm text-muted">
            {method === "totp"
              ? "Enter the code from your authenticator app."
              : "Enter one of your unused backup codes."}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="two-factor-code" className="font-mono text-xs uppercase tracking-widest text-muted">
              {method === "totp" ? "6-digit code" : "Backup code"}
            </label>
            <input
              id="two-factor-code"
              type="text"
              inputMode={method === "totp" ? "numeric" : "text"}
              pattern={method === "totp" ? "[0-9]*" : undefined}
              maxLength={method === "totp" ? 6 : 12}
              required
              autoFocus
              autoComplete="one-time-code"
              value={code}
              onChange={(e) =>
                setCode(method === "totp" ? e.target.value.replace(/\D/g, "") : e.target.value)
              }
              className="rounded-[4px] bg-surface-low border border-border text-foreground placeholder:text-muted/50 focus:border-foreground/40 transition-colors duration-150 ease-out-strong px-3 py-2 text-sm tracking-[0.5em] text-center outline-none"
            />
          </div>

          {error && <p className="text-sm text-error">{error}</p>}

          <button
            type="submit"
            disabled={verifying || code.length === 0}
            className="rounded-[4px] bg-accent-brand text-accent-brand-foreground font-mono text-sm font-medium hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong py-2 disabled:opacity-50"
          >
            {verifying ? "Verifying..." : "Verify"}
          </button>

          <button
            type="button"
            onClick={() => {
              setMethod(method === "totp" ? "backup" : "totp");
              setCode("");
              setError(null);
            }}
            className="font-mono text-sm text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
          >
            {method === "totp" ? "Use a backup code instead" : "Use your authenticator app instead"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function VerifyTwoFactorPage() {
  return (
    <div className="flex-1 flex flex-col">
      <MarketingHeader />
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-16">
        <Suspense fallback={<p className="font-mono text-sm text-muted">Loading…</p>}>
          <VerifyTwoFactorForm />
        </Suspense>
      </main>
    </div>
  );
}

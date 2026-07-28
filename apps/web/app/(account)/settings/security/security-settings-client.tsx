"use client";

import { useEffect, useState } from "react";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import QRCode from "qrcode";
import { AccountSidebarToggle } from "@/components/account-sidebar";
import { BillingGate } from "@/components/billing-gate";
import { TerminalBlock } from "@/components/terminal-block";
import { TwoFactorGate, markTwoFactorVerified } from "@/components/two-factor-gate";
import { authClient } from "@/lib/auth-client";
import type { auth } from "@/lib/auth";

type ServerSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

type Role = "owner" | "admin" | "member" | null;
type EnrollStep = "idle" | "scan";

// TOTP's own otpauth URI carries the raw secret as a query param -- pulled
// out here for the "can't scan? type this in" fallback every authenticator
// app's own onboarding offers, rather than leaving a QR code as the only
// way in for someone on a device that can't scan its own screen.
function secretFromTotpUri(totpURI: string): string | null {
  try {
    return new URL(totpURI).searchParams.get("secret");
  } catch {
    return null;
  }
}

function useActiveRole(): Role {
  const [role, setRole] = useState<Role>(null);
  useEffect(() => {
    let cancelled = false;
    authClient.organization.getActiveMemberRole().then(({ data }) => {
      if (!cancelled) setRole((data?.role as Role) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return role;
}

// The session is already resolved server-side (see page.tsx) -- this only
// owns what's genuinely client-only: the 2FA enrollment/QR/disable flow.
export function SecuritySettingsClient({ session }: { session: ServerSession }) {
  const role = useActiveRole();
  const isAdminRole = role === "owner" || role === "admin";

  const [step, setStep] = useState<EnrollStep>("idle");
  const [totpURI, setTotpURI] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDisable, setConfirmingDisable] = useState(false);

  useEffect(() => {
    // Nothing to render either way while totpURI is unset -- the QR block
    // below only ever renders when step === "scan" && totpURI, so a stale
    // qrDataUrl lingering after that isn't reachable, and there's no need
    // to clear it synchronously here.
    if (!totpURI) return;
    let cancelled = false;
    QRCode.toDataURL(totpURI, { margin: 1, width: 220 }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [totpURI]);

  async function startEnrollment() {
    setError(null);
    setBusy(true);
    // No password field -- allowPasswordless on the server plugin (see
    // lib/auth.ts) is exactly for accounts like every one of ours, which
    // never has a credential/password account to check against.
    const { data, error: enableError } = await authClient.twoFactor.enable({});
    setBusy(false);
    if (enableError || !data) {
      setError(enableError?.message ?? "Couldn't start 2FA setup. Try again.");
      return;
    }
    setTotpURI(data.totpURI);
    setBackupCodes(data.backupCodes);
    setStep("scan");
  }

  async function confirmEnrollment(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error: verifyError } = await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (verifyError) {
      setError("That code didn't work. Check your authenticator app and try again.");
      return;
    }
    // The enrolling browser just proved it holds a valid code -- don't make
    // it immediately re-prove that to components/two-factor-gate.tsx on the
    // very next page it visits.
    markTwoFactorVerified(session.user.id);
    setStep("idle");
    setTotpURI(null);
    setCode("");
  }

  async function disable() {
    setError(null);
    setBusy(true);
    const { error: disableError } = await authClient.twoFactor.disable({});
    setBusy(false);
    setConfirmingDisable(false);
    if (disableError) {
      setError(disableError.message ?? "Couldn't disable 2FA. Try again.");
    }
  }

  const enabled = session.user.twoFactorEnabled;

  return (
    <>
      {/* Gates this page too, not just the pages 2FA protects -- otherwise
          a browser holding a real session but no cleared TOTP challenge
          could open its own 2FA management (including Disable) without
          ever proving it controls the authenticator app. See the
          component's own comment for the full "why this page exists" story. */}
      <TwoFactorGate />
      <BillingGate />
      <header className="flex items-center gap-3 border-b border-border px-6 py-4">
        <AccountSidebarToggle />
        <h1 className="font-mono text-lg font-semibold text-foreground">Security</h1>
      </header>
      <main className="flex-1 flex flex-col items-center px-6 py-8">
        <div className="w-full flex flex-col items-start gap-5 text-left">
          <div className="flex flex-col items-start gap-2">
            <p className="font-mono text-xs uppercase tracking-widest text-muted">Settings</p>
            <h1 className="font-mono text-2xl font-bold tracking-tight">Two-factor authentication</h1>
            <p className="font-mono text-sm text-muted">
              An authenticator app code, in addition to your usual sign-in, so a stolen session
              cookie or a compromised inbox isn&apos;t enough on its own.
            </p>
          </div>

          {isAdminRole && !enabled && step === "idle" && (
            <div className="w-full flex items-start gap-3 border border-border bg-surface-low px-4 py-3">
              <ShieldAlert className="h-4 w-4 text-error shrink-0 mt-0.5" aria-hidden="true" />
              <p className="font-mono text-sm text-foreground">
                2FA is required for owner and admin accounts. Enable it below to keep access to
                admin-only actions.
              </p>
            </div>
          )}

          {enabled && step === "idle" && (
            <div className="w-full flex flex-col gap-4">
              <div className="w-full flex items-center gap-3 border border-border bg-surface-low px-4 py-3">
                <ShieldCheck className="h-4 w-4 text-success shrink-0" aria-hidden="true" />
                <p className="font-mono text-sm text-foreground">2FA is enabled on this account.</p>
              </div>

              {!confirmingDisable && (
                <button
                  type="button"
                  onClick={() => setConfirmingDisable(true)}
                  className="self-start font-mono text-sm text-muted hover:text-error transition-colors duration-150 ease-out-strong"
                >
                  Disable 2FA
                </button>
              )}

              {confirmingDisable && (
                <div className="w-full flex flex-col gap-3 border border-border bg-surface-low px-4 py-3">
                  <p className="font-mono text-sm text-foreground">
                    {isAdminRole
                      ? "You're an owner or admin — 2FA is required for that role. Disabling it now will limit you from admin-only actions until you re-enable it."
                      : "Sign-in will no longer ask for a second code."}
                  </p>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={disable}
                      disabled={busy}
                      className="font-mono text-sm text-error hover:opacity-80 transition-opacity duration-150 ease-out-strong disabled:opacity-50"
                    >
                      {busy ? "Disabling..." : "Confirm disable"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDisable(false)}
                      className="font-mono text-sm text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {!enabled && step === "idle" && (
            <button
              type="button"
              onClick={startEnrollment}
              disabled={busy}
              className="rounded-[4px] bg-accent-brand text-accent-brand-foreground font-mono text-sm font-medium hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong px-5 py-2 disabled:opacity-50"
            >
              {busy ? "Starting..." : "Enable 2FA"}
            </button>
          )}

          {step === "scan" && totpURI && backupCodes && (
            <div className="w-full flex flex-col gap-6">
              <div className="w-full flex flex-col gap-3">
                <p className="font-mono text-xs uppercase tracking-widest text-muted">
                  1. Scan with your authenticator app
                </p>
                <div className="flex flex-col items-center gap-3 border border-border bg-surface-low px-4 py-5">
                  {qrDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- client-generated data: URI, not an optimizable remote asset.
                    <img
                      src={qrDataUrl}
                      alt="Scan this QR code with your authenticator app"
                      className="bg-white p-3 rounded-[4px]"
                      width={220}
                      height={220}
                    />
                  ) : (
                    <p className="font-mono text-sm text-muted">Generating QR code…</p>
                  )}
                  <p className="font-mono text-xs text-muted text-center">
                    Can&apos;t scan?{" "}
                    <span className="text-foreground break-all">{secretFromTotpUri(totpURI)}</span>
                  </p>
                </div>
              </div>

              <div className="w-full flex flex-col gap-3">
                <p className="font-mono text-xs uppercase tracking-widest text-muted">
                  2. Save your backup codes
                </p>
                <p className="font-mono text-sm text-muted">
                  Shown once, right now. Each one signs you in a single time if you lose access to
                  your authenticator app — store them somewhere safe before continuing.
                </p>
                <TerminalBlock lines={backupCodes} copyText={backupCodes.join("\n")} />
              </div>

              <div className="w-full flex flex-col gap-3">
                <p className="font-mono text-xs uppercase tracking-widest text-muted">
                  3. Confirm setup
                </p>
                <form onSubmit={confirmEnrollment} className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="confirm-code"
                      className="font-mono text-xs uppercase tracking-widest text-muted"
                    >
                      6-digit code
                    </label>
                    <input
                      id="confirm-code"
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

                  <div className="flex gap-3">
                    <button
                      type="submit"
                      disabled={busy || code.length !== 6}
                      className="rounded-[4px] bg-accent-brand text-accent-brand-foreground font-mono text-sm font-medium hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong px-5 py-2 disabled:opacity-50"
                    >
                      {busy ? "Verifying..." : "Confirm & enable"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setStep("idle");
                        setTotpURI(null);
                        setBackupCodes(null);
                        setCode("");
                        setError(null);
                      }}
                      className="font-mono text-sm text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {error && step === "idle" && <p className="text-sm text-error">{error}</p>}
        </div>
      </main>
    </>
  );
}

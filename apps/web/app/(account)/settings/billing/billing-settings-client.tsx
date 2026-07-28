"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AccountSidebarToggle } from "@/components/account-sidebar";
import { BillingGate } from "@/components/billing-gate";
import { TwoFactorGate } from "@/components/two-factor-gate";
import { API_URL } from "@/lib/api-url";
import { authClient } from "@/lib/auth-client";
import type { ServerApiResult } from "@/lib/server-api";

// Mirrors gnt.routers.billing's BillingStatus response model exactly
// (apps/api/src/gnt/routers/billing.py).
export type BillingStatus = {
  entitled: boolean;
  subscription_status: string | null;
  trial_ends_at: string | null;
  plan_tier: string;
  monthly_actions_used: number;
  monthly_actions_cap: number;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
};

// Mirrors PaymentMethodInfo -- null when the org has no card on file yet
// (a trialing org that hasn't been through Checkout).
export type PaymentMethod = {
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
} | null;

// Mirrors InvoiceInfo.
export type Invoice = {
  id: string;
  number: string | null;
  created: string;
  status: string | null;
  amount_paid: number;
  currency: string;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
};

const PLAN_LABEL: Record<string, string> = {
  base: "Base",
  pro: "Pro",
};

// Matches the live prices on /pricing (apps/web/app/pricing/page.tsx) --
// the only other place these numbers are hardcoded, both mirror
// gnt.billing's two configured Stripe prices.
const PLAN_PRICE: Record<string, string> = {
  base: "$29",
  pro: "$149",
};

function formatAmount(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}

function invoiceStatusClass(invoiceStatus: string | null): string {
  if (invoiceStatus === "paid") return "text-success";
  if (invoiceStatus === "open" || invoiceStatus === "uncollectible" || invoiceStatus === "void") return "text-error";
  return "text-muted";
}

// Session/auth gating is handled server-side (see page.tsx and
// app/(account)/layout.tsx) -- page.tsx also fetches all three of these
// itself and passes them down as initialStatus/initialPaymentMethod/
// initialInvoices, so the common case renders real content on arrival
// instead of mounting to three empty "Loading…" panels. The effects below
// only run when their initial value didn't come back ok (no server
// token, apps/api/Stripe hiccup) -- same fetch-and-render-with-a-specific-
// error-message path this page always had, now just a fallback. All three
// hit real API endpoints (apps/api/src/gnt/routers/billing.py) backed by
// live Stripe data -- payment-method and invoices are new routes added
// alongside this page (gnt.billing.get_default_payment_method/
// list_invoices), not placeholder content.
export function BillingSettingsClient({
  initialStatus,
  initialPaymentMethod,
  initialInvoices,
}: {
  initialStatus: BillingStatus | null;
  initialPaymentMethod: ServerApiResult<PaymentMethod>;
  initialInvoices: Invoice[] | null;
}) {
  const [status, setStatus] = useState<BillingStatus | null>(initialStatus);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(initialStatus === null);

  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(initialPaymentMethod.data);
  const [paymentMethodError, setPaymentMethodError] = useState<string | null>(null);
  const [loadingPaymentMethod, setLoadingPaymentMethod] = useState(!initialPaymentMethod.ok);

  const [invoices, setInvoices] = useState<Invoice[] | null>(initialInvoices);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [loadingInvoices, setLoadingInvoices] = useState(initialInvoices === null);

  const [managing, setManaging] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    if (initialStatus !== null) return;
    let cancelled = false;
    async function load() {
      const { data, error } = await authClient.token();
      const token = data?.token;
      if (error || !token) {
        if (!cancelled) setStatusError("Couldn't verify your session. Try signing in again.");
        if (!cancelled) setLoadingStatus(false);
        return;
      }
      try {
        // require_admin is the only 403 source here, but it covers two
        // different real reasons (see get_current_org/require_admin in
        // apps/api/src/gnt/auth/better_auth.py): no active org on this
        // session at all, or an active org where this account isn't
        // owner/admin. Surfacing the API's own detail message is more
        // accurate than guessing which of those this is.
        const res = await fetch(`${API_URL}/v1/billing/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setStatusError(
            typeof body?.detail === "string" ? body.detail : "Couldn't load billing status. Try again in a moment.",
          );
          return;
        }
        setStatus(await res.json());
      } catch {
        if (!cancelled) setStatusError("Couldn't reach billing. Check your connection and try again.");
      } finally {
        if (!cancelled) setLoadingStatus(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // initialStatus is a one-time seed (see the comment above this
    // component), not a value this effect should re-run on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (initialPaymentMethod.ok) return;
    let cancelled = false;
    async function load() {
      const { data, error } = await authClient.token();
      const token = data?.token;
      if (error || !token) {
        if (!cancelled) setPaymentMethodError("Couldn't verify your session. Try signing in again.");
        if (!cancelled) setLoadingPaymentMethod(false);
        return;
      }
      try {
        const res = await fetch(`${API_URL}/v1/billing/payment-method`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (!res.ok) {
          setPaymentMethodError("Couldn't load your payment method. Try again in a moment.");
          return;
        }
        setPaymentMethod(await res.json());
      } catch {
        if (!cancelled) setPaymentMethodError("Couldn't reach billing. Check your connection and try again.");
      } finally {
        if (!cancelled) setLoadingPaymentMethod(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // initialPaymentMethod is a one-time seed, same reasoning as the status effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (initialInvoices !== null) return;
    let cancelled = false;
    async function load() {
      const { data, error } = await authClient.token();
      const token = data?.token;
      if (error || !token) {
        if (!cancelled) setInvoicesError("Couldn't verify your session. Try signing in again.");
        if (!cancelled) setLoadingInvoices(false);
        return;
      }
      try {
        const res = await fetch(`${API_URL}/v1/billing/invoices`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (!res.ok) {
          setInvoicesError("Couldn't load your invoice history. Try again in a moment.");
          return;
        }
        setInvoices(await res.json());
      } catch {
        if (!cancelled) setInvoicesError("Couldn't reach billing. Check your connection and try again.");
      } finally {
        if (!cancelled) setLoadingInvoices(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // initialInvoices is a one-time seed, same reasoning as the status effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function manageBilling() {
    setPortalError(null);
    setManaging(true);
    const { data, error } = await authClient.token();
    const token = data?.token;
    if (error || !token) {
      setManaging(false);
      setPortalError("Couldn't verify your session. Try again.");
      return;
    }
    try {
      const res = await fetch(`${API_URL}/v1/billing/portal`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setManaging(false);
        setPortalError("Couldn't open the billing portal. Try again in a moment.");
        return;
      }
      const { url } = await res.json();
      window.location.href = url;
    } catch {
      setManaging(false);
      setPortalError("Couldn't reach billing. Check your connection and try again.");
    }
  }

  // In-app cancel -- no Stripe portal round-trip. Confirmed once inline
  // (confirmingCancel) rather than a native window.confirm(), same
  // "no browser-chrome dialogs" preference the rest of this site's custom
  // UI already follows. Updates `status` locally with the response's
  // cancel_at instead of refetching -- the API already hands back exactly
  // what changed.
  async function cancelSubscription() {
    setCancelError(null);
    setCanceling(true);
    const { data, error } = await authClient.token();
    const token = data?.token;
    if (error || !token) {
      setCanceling(false);
      setCancelError("Couldn't verify your session. Try again.");
      return;
    }
    try {
      const res = await fetch(`${API_URL}/v1/billing/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setCanceling(false);
        setCancelError("Couldn't cancel your subscription. Try again in a moment, or contact support.");
        return;
      }
      const { cancel_at } = await res.json();
      setStatus((prev) => (prev ? { ...prev, cancel_at_period_end: true, current_period_end: cancel_at } : prev));
      setConfirmingCancel(false);
    } catch {
      setCancelError("Couldn't reach billing. Check your connection and try again.");
    } finally {
      setCanceling(false);
    }
  }

  return (
    <>
      <TwoFactorGate />
      <BillingGate />

      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <AccountSidebarToggle />
          <h1 className="font-mono text-lg font-semibold text-foreground">Billing</h1>
        </div>

        <button
          type="button"
          onClick={manageBilling}
          disabled={managing}
          className="rounded-[4px] bg-accent-brand px-4 py-2 font-mono text-sm font-medium text-accent-brand-foreground transition-[opacity,transform] duration-150 ease-out-strong hover:opacity-90 active:scale-95 disabled:opacity-50"
        >
          {managing ? "Opening…" : "Manage billing"}
        </button>
      </header>

      <main className="flex-1 space-y-4 p-5">
          {portalError && <p className="font-mono text-sm text-error">{portalError}</p>}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="border border-border p-5">
              <div className="flex items-center justify-between">
                <h2 className="font-mono text-sm font-medium text-foreground">Current plan</h2>
                {status && (
                  <span className="rounded-[4px] bg-surface-high px-2.5 py-0.5 font-mono text-xs text-foreground">
                    {PLAN_LABEL[status.plan_tier] ?? status.plan_tier}
                  </span>
                )}
              </div>

              {loadingStatus && <p className="mt-3 font-mono text-sm text-muted">Loading…</p>}
              {!loadingStatus && statusError && <p className="mt-3 font-mono text-sm text-muted">{statusError}</p>}

              {!loadingStatus && status && (
                <div className="mt-3 flex flex-col gap-3">
                  <p>
                    <span className="font-mono text-2xl font-medium text-foreground">
                      {PLAN_PRICE[status.plan_tier] ?? "—"}
                    </span>
                    <span className="font-mono text-xs text-muted">/month</span>
                  </p>

                  <div className="flex flex-col border border-border divide-y divide-border">
                    <div className="flex items-center justify-between px-4 py-2">
                      <span className="font-mono text-xs uppercase tracking-widest text-muted">Usage</span>
                      <span className="font-mono text-sm text-foreground">
                        {status.monthly_actions_used.toLocaleString()} / {status.monthly_actions_cap.toLocaleString()}{" "}
                        actions
                      </span>
                    </div>
                    <div className="flex items-center justify-between px-4 py-2">
                      <span className="font-mono text-xs uppercase tracking-widest text-muted">Status</span>
                      <span className="font-mono text-sm text-foreground">
                        {status.subscription_status ?? "No subscription"}
                      </span>
                    </div>
                    {status.current_period_end && (
                      <div className="flex items-center justify-between px-4 py-2">
                        <span className="font-mono text-xs uppercase tracking-widest text-muted">
                          {status.cancel_at_period_end ? "Access until" : "Renews"}
                        </span>
                        <span className="font-mono text-sm text-foreground">
                          {new Date(status.current_period_end).toLocaleDateString()}
                        </span>
                      </div>
                    )}
                    {!status.current_period_end && status.trial_ends_at && (
                      <div className="flex items-center justify-between px-4 py-2">
                        <span className="font-mono text-xs uppercase tracking-widest text-muted">Trial ends</span>
                        <span className="font-mono text-sm text-foreground">
                          {new Date(status.trial_ends_at).toLocaleDateString()}
                        </span>
                      </div>
                    )}
                  </div>

                  {status.cancel_at_period_end && (
                    <p className="font-mono text-sm text-muted">
                      Canceling — no further charges after the date above.
                    </p>
                  )}

                  {cancelError && <p className="font-mono text-sm text-error">{cancelError}</p>}

                  <div className="flex flex-wrap items-center gap-3">
                    <Link
                      href="/pricing"
                      className="inline-block rounded-[4px] border border-border px-4 py-2 font-mono text-sm font-medium text-foreground transition-colors duration-150 ease-out-strong hover:border-foreground/30"
                    >
                      Change plan
                    </Link>

                    {status.entitled && status.subscription_status && !status.cancel_at_period_end && !confirmingCancel && (
                      <button
                        type="button"
                        onClick={() => setConfirmingCancel(true)}
                        className="rounded-[4px] border border-border px-4 py-2 font-mono text-sm font-medium text-muted transition-colors duration-150 ease-out-strong hover:border-foreground/30 hover:text-foreground"
                      >
                        Cancel subscription
                      </button>
                    )}
                  </div>

                  {confirmingCancel && (
                    <div className="flex flex-col gap-2 border border-border px-4 py-3">
                      <p className="font-mono text-sm text-foreground">
                        Cancel your subscription? You&apos;ll keep access until the end of the current billing
                        period, then it ends — no partial refund, no further charges.
                      </p>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={cancelSubscription}
                          disabled={canceling}
                          className="rounded-[4px] border border-error px-4 py-2 font-mono text-sm font-medium text-error transition-[background-color,transform] duration-150 ease-out-strong hover:bg-error/10 active:scale-95 disabled:opacity-50"
                        >
                          {canceling ? "Canceling…" : "Yes, cancel"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingCancel(false)}
                          disabled={canceling}
                          className="font-mono text-sm text-muted transition-colors duration-150 ease-out-strong hover:text-foreground disabled:opacity-50"
                        >
                          Never mind
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="border border-border p-5">
              <h2 className="font-mono text-sm font-medium text-foreground">Payment method</h2>

              {loadingPaymentMethod && <p className="mt-3 font-mono text-sm text-muted">Loading…</p>}
              {!loadingPaymentMethod && paymentMethodError && (
                <p className="mt-3 font-mono text-sm text-muted">{paymentMethodError}</p>
              )}

              {!loadingPaymentMethod && !paymentMethodError && paymentMethod && (
                <div className="mt-3 flex items-center gap-3">
                  <span className="grid h-8 w-12 shrink-0 place-content-center rounded-[4px] bg-surface-high font-mono text-xs font-medium uppercase text-foreground">
                    {paymentMethod.brand}
                  </span>
                  <div className="font-mono text-sm">
                    <p className="font-medium text-foreground">Ending in {paymentMethod.last4}</p>
                    <p className="text-muted">
                      Expires {String(paymentMethod.exp_month).padStart(2, "0")}/{paymentMethod.exp_year}
                    </p>
                  </div>
                </div>
              )}

              {!loadingPaymentMethod && !paymentMethodError && !paymentMethod && (
                <p className="mt-3 font-mono text-sm text-muted">No card on file.</p>
              )}

              <button
                type="button"
                onClick={manageBilling}
                disabled={managing}
                className="mt-3 inline-block rounded-[4px] border border-border px-4 py-2 font-mono text-sm font-medium text-foreground transition-colors duration-150 ease-out-strong hover:border-foreground/30 disabled:opacity-50"
              >
                {managing ? "Opening…" : "Update card"}
              </button>
            </div>
          </div>

          <div className="border border-border p-5">
            <h2 className="font-mono text-sm font-medium text-foreground">Invoice history</h2>

            {/* Capped and internally scrollable -- an invoice table grows
                without bound over an account's lifetime; letting it push
                the whole page taller would eventually blow past a single
                viewport no matter how tight everything else is. */}
            <div className="mt-3 max-h-56 overflow-auto">
              {loadingInvoices && <p className="font-mono text-sm text-muted">Loading…</p>}
              {!loadingInvoices && invoicesError && <p className="font-mono text-sm text-muted">{invoicesError}</p>}
              {!loadingInvoices && !invoicesError && invoices?.length === 0 && (
                <p className="font-mono text-sm text-muted">No invoices yet.</p>
              )}

              {!loadingInvoices && !invoicesError && invoices && invoices.length > 0 && (
                <table className="min-w-full divide-y divide-border">
                  <thead>
                    <tr className="text-left">
                      <th className="whitespace-nowrap px-3 py-2 font-mono text-xs uppercase tracking-widest text-muted">
                        Invoice
                      </th>
                      <th className="whitespace-nowrap px-3 py-2 font-mono text-xs uppercase tracking-widest text-muted">
                        Date
                      </th>
                      <th className="whitespace-nowrap px-3 py-2 font-mono text-xs uppercase tracking-widest text-muted">
                        Status
                      </th>
                      <th className="whitespace-nowrap px-3 py-2 font-mono text-xs uppercase tracking-widest text-muted">
                        Amount
                      </th>
                      <th className="whitespace-nowrap px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {invoices.map((invoice) => (
                      <tr key={invoice.id}>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-sm font-medium text-foreground">
                          {invoice.number ?? invoice.id}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-sm text-foreground">
                          {new Date(invoice.created).toLocaleDateString()}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-sm">
                          <span className={invoiceStatusClass(invoice.status)}>[{invoice.status ?? "unknown"}]</span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-sm text-foreground">
                          {formatAmount(invoice.amount_paid, invoice.currency)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {(invoice.hosted_invoice_url || invoice.invoice_pdf) && (
                            <a
                              href={invoice.hosted_invoice_url ?? invoice.invoice_pdf ?? "#"}
                              target="_blank"
                              rel="noreferrer"
                              className="font-mono text-sm font-medium text-foreground underline underline-offset-2"
                            >
                              Download
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
      </main>
    </>
  );
}

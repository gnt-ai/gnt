"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { API_URL } from "@/lib/api-url";
import { authClient } from "@/lib/auth-client";

// Mirrors GET /v1/platform-admin/orgs's response shape exactly.
export type OrgSummary = {
  id: string;
  name: string;
  plan_tier: "base" | "pro";
  subscription_status: string | null;
  trial_ends_at: string | null;
  member_count: number;
  monthly_actions_used: number;
  monthly_actions_cap: number;
  llm_spend_cents_this_month: number;
};

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

// Founder-only internal tool, not customer-facing -- the real gate is
// apps/api's platform-admin allowlist check on this same request, not
// anything client-side. A 403 means "you're not allowed here" (checked
// explicitly below, before the generic error path), so it gets its own
// terminal state instead of a retry-flavored error message.
export function OrgListClient() {
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data, error: tokenError } = await authClient.token();
      const token = data?.token;
      if (tokenError || !token) {
        if (!cancelled) {
          setError("Couldn't verify your session. Try signing in again.");
          setLoading(false);
        }
        return;
      }
      try {
        const res = await fetch(`${API_URL}/v1/platform-admin/orgs`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (res.status === 403) {
          setForbidden(true);
          return;
        }
        if (!res.ok) {
          setError("Couldn't load organizations. Try again in a moment.");
          return;
        }
        setOrgs(await res.json());
      } catch {
        if (!cancelled) setError("Couldn't reach the API. Check your connection and try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border px-6 py-4">
        <h1 className="font-mono text-lg font-semibold text-foreground">Platform admin</h1>
      </header>

      <main className="flex-1 p-5">
        {loading && <p className="font-mono text-sm text-muted">Loading…</p>}

        {!loading && forbidden && (
          <div className="flex flex-col items-start gap-2">
            <h2 className="font-mono text-xl font-bold tracking-tight">Not authorized</h2>
            <p className="font-mono text-sm text-muted">Your account isn&apos;t on the platform-admin allowlist.</p>
          </div>
        )}

        {!loading && !forbidden && error && <p className="font-mono text-sm text-muted">{error}</p>}

        {!loading && !forbidden && !error && orgs && orgs.length === 0 && (
          <p className="font-mono text-sm text-muted">No organizations yet.</p>
        )}

        {!loading && !forbidden && !error && orgs && orgs.length > 0 && (
          <div className="w-full overflow-x-auto border border-border">
            <table className="min-w-full divide-y divide-border">
              <thead>
                <tr className="text-left">
                  <th className="whitespace-nowrap px-3 py-2 font-mono text-xs uppercase tracking-widest text-muted">
                    Org
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-mono text-xs uppercase tracking-widest text-muted">
                    Plan
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-mono text-xs uppercase tracking-widest text-muted">
                    Status
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-mono text-xs uppercase tracking-widest text-muted">
                    Trial ends
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-mono text-xs uppercase tracking-widest text-muted">
                    Members
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-mono text-xs uppercase tracking-widest text-muted">
                    Usage
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-mono text-xs uppercase tracking-widest text-muted">
                    Spend (mo)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {orgs.map((org) => (
                  <tr key={org.id}>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-sm font-medium text-foreground">
                      <Link
                        href={`/admin/${org.id}`}
                        className="underline underline-offset-2 transition-colors duration-150 ease-out-strong hover:text-muted"
                      >
                        {org.name}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-sm capitalize text-foreground">
                      {org.plan_tier}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-sm text-foreground">
                      {org.subscription_status ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-sm text-foreground">
                      {org.trial_ends_at ? new Date(org.trial_ends_at).toLocaleDateString() : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-sm text-foreground">
                      {org.member_count}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-sm text-foreground">
                      {org.monthly_actions_used.toLocaleString()} / {org.monthly_actions_cap.toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-sm text-foreground">
                      {formatCents(org.llm_spend_cents_this_month)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

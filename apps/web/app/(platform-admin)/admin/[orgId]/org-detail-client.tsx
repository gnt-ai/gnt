"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { API_URL } from "@/lib/api-url";
import { authClient } from "@/lib/auth-client";

type PlanTier = "base" | "pro";

// Mirrors GET /v1/platform-admin/orgs/{org_id}'s response shape exactly.
type OrgDetail = {
  id: string;
  name: string;
  plan_tier: PlanTier;
  subscription_status: string | null;
  trial_ends_at: string | null;
  members: { email: string; name: string; role: string }[];
  rules_by_status: {
    draft: number;
    in_review: number;
    pending_merge: number;
    approved: number;
    deprecated: number;
  };
  open_gaps_count: number;
  connectors: Record<"github" | "slack" | "zendesk" | "intercom" | "notion" | "linear", { connected: boolean }>;
  mcp_keys_count: number;
};

const RULE_STATUS_LABEL: Record<keyof OrgDetail["rules_by_status"], string> = {
  draft: "Draft",
  in_review: "In review",
  pending_merge: "Pending merge",
  approved: "Approved",
  deprecated: "Deprecated",
};

const CONNECTOR_LABEL: Record<keyof OrgDetail["connectors"], string> = {
  github: "GitHub",
  slack: "Slack",
  zendesk: "Zendesk",
  intercom: "Intercom",
  notion: "Notion",
  linear: "Linear",
};

// Founder-only internal tool -- same "the API is the real gate, a 403 is
// its own terminal state" posture as ../org-list-client.tsx.
export function OrgDetailClient({ orgId }: { orgId: string }) {
  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedTier, setSelectedTier] = useState<PlanTier>("base");
  const [savingTier, setSavingTier] = useState(false);
  const [tierError, setTierError] = useState<string | null>(null);
  const [tierSaved, setTierSaved] = useState(false);

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
        const res = await fetch(`${API_URL}/v1/platform-admin/orgs/${orgId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (res.status === 403) {
          setForbidden(true);
          return;
        }
        if (!res.ok) {
          setError("Couldn't load this organization. Try again in a moment.");
          return;
        }
        const body = (await res.json()) as OrgDetail;
        setOrg(body);
        setSelectedTier(body.plan_tier);
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
  }, [orgId]);

  async function updatePlanTier(e: React.FormEvent) {
    e.preventDefault();
    setTierError(null);
    setTierSaved(false);
    setSavingTier(true);
    const { data, error: tokenError } = await authClient.token();
    const token = data?.token;
    if (tokenError || !token) {
      setSavingTier(false);
      setTierError("Couldn't verify your session. Try again.");
      return;
    }
    try {
      const res = await fetch(`${API_URL}/v1/platform-admin/orgs/${orgId}/plan-tier`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ plan_tier: selectedTier }),
      });
      if (!res.ok) {
        setTierError("Couldn't update the plan. Try again in a moment.");
        return;
      }
      const { plan_tier } = (await res.json()) as { org_id: string; plan_tier: PlanTier };
      setOrg((prev) => (prev ? { ...prev, plan_tier } : prev));
      setTierSaved(true);
    } catch {
      setTierError("Couldn't reach the API. Check your connection and try again.");
    } finally {
      setSavingTier(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 py-4">
        <Link
          href="/admin"
          className="font-mono text-sm text-muted transition-colors duration-150 ease-out-strong hover:text-foreground"
        >
          ← Orgs
        </Link>
        <h1 className="font-mono text-lg font-semibold text-foreground">{org?.name ?? "Organization"}</h1>
      </header>

      <main className="flex-1 space-y-4 p-5">
        {loading && <p className="font-mono text-sm text-muted">Loading…</p>}

        {!loading && forbidden && (
          <div className="flex flex-col items-start gap-2">
            <h2 className="font-mono text-xl font-bold tracking-tight">Not authorized</h2>
            <p className="font-mono text-sm text-muted">Your account isn&apos;t on the platform-admin allowlist.</p>
          </div>
        )}

        {!loading && !forbidden && error && <p className="font-mono text-sm text-muted">{error}</p>}

        {!loading && !forbidden && !error && org && (
          <>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="border border-border p-5">
                <h2 className="font-mono text-sm font-medium text-foreground">Plan &amp; status</h2>
                <div className="mt-3 flex flex-col border border-border divide-y divide-border">
                  <div className="flex items-center justify-between px-4 py-2">
                    <span className="font-mono text-xs uppercase tracking-widest text-muted">Plan</span>
                    <span className="font-mono text-sm capitalize text-foreground">{org.plan_tier}</span>
                  </div>
                  <div className="flex items-center justify-between px-4 py-2">
                    <span className="font-mono text-xs uppercase tracking-widest text-muted">Status</span>
                    <span className="font-mono text-sm text-foreground">{org.subscription_status ?? "—"}</span>
                  </div>
                  {org.trial_ends_at && (
                    <div className="flex items-center justify-between px-4 py-2">
                      <span className="font-mono text-xs uppercase tracking-widest text-muted">Trial ends</span>
                      <span className="font-mono text-sm text-foreground">
                        {new Date(org.trial_ends_at).toLocaleDateString()}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between px-4 py-2">
                    <span className="font-mono text-xs uppercase tracking-widest text-muted">MCP keys</span>
                    <span className="font-mono text-sm text-foreground">{org.mcp_keys_count}</span>
                  </div>
                  <div className="flex items-center justify-between px-4 py-2">
                    <span className="font-mono text-xs uppercase tracking-widest text-muted">Open gaps</span>
                    <span className="font-mono text-sm text-foreground">{org.open_gaps_count}</span>
                  </div>
                </div>

                <form onSubmit={updatePlanTier} className="mt-4 flex items-center gap-2">
                  <select
                    value={selectedTier}
                    onChange={(e) => {
                      setSelectedTier(e.target.value as PlanTier);
                      setTierSaved(false);
                    }}
                    className="rounded-[4px] border border-border bg-surface-low px-3 py-2 font-mono text-sm text-foreground outline-none transition-colors duration-150 ease-out-strong focus:border-foreground/40"
                  >
                    <option value="base">Base</option>
                    <option value="pro">Pro</option>
                  </select>
                  <button
                    type="submit"
                    disabled={savingTier || selectedTier === org.plan_tier}
                    className="rounded-[4px] bg-accent-brand px-4 py-2 font-mono text-sm font-medium text-accent-brand-foreground transition-[opacity,transform] duration-150 ease-out-strong hover:opacity-90 active:scale-95 disabled:opacity-50"
                  >
                    {savingTier ? "Updating…" : "Update plan"}
                  </button>
                </form>
                {tierError && <p className="mt-2 font-mono text-sm text-error">{tierError}</p>}
                {tierSaved && !tierError && <p className="mt-2 font-mono text-sm text-success">Plan updated.</p>}
              </div>

              <div className="border border-border p-5">
                <h2 className="font-mono text-sm font-medium text-foreground">Connectors</h2>
                <div className="mt-3 flex flex-col border border-border divide-y divide-border">
                  {(Object.keys(CONNECTOR_LABEL) as (keyof OrgDetail["connectors"])[]).map((key) => (
                    <div key={key} className="flex items-center justify-between px-4 py-2">
                      <span className="font-mono text-sm text-foreground">{CONNECTOR_LABEL[key]}</span>
                      <span
                        className={
                          org.connectors[key]?.connected
                            ? "font-mono text-xs text-success"
                            : "font-mono text-xs text-muted"
                        }
                      >
                        {org.connectors[key]?.connected ? "Connected" : "Not connected"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="border border-border p-5">
              <h2 className="font-mono text-sm font-medium text-foreground">Rules by status</h2>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                {(Object.keys(RULE_STATUS_LABEL) as (keyof OrgDetail["rules_by_status"])[]).map((key) => (
                  <div key={key} className="border border-border p-3">
                    <p className="font-mono text-xs uppercase tracking-widest text-muted">
                      {RULE_STATUS_LABEL[key]}
                    </p>
                    <p className="mt-1 font-mono text-xl font-medium text-foreground">{org.rules_by_status[key]}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="border border-border p-5">
              <h2 className="font-mono text-sm font-medium text-foreground">Members ({org.members.length})</h2>
              {org.members.length === 0 ? (
                <p className="mt-3 font-mono text-sm text-muted">No members.</p>
              ) : (
                <div className="mt-3 max-h-72 overflow-y-auto border border-border divide-y divide-border">
                  {org.members.map((member) => (
                    <div key={member.email} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-mono text-sm text-foreground">
                          {member.name || member.email}
                        </span>
                        {member.name && (
                          <span className="truncate font-mono text-xs text-muted">{member.email}</span>
                        )}
                      </div>
                      <span className="shrink-0 font-mono text-xs uppercase tracking-widest text-muted">
                        {member.role}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

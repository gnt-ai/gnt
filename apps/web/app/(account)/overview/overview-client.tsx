"use client";

import { useEffect, useMemo, useState } from "react";
import { AccountSidebarToggle } from "@/components/account-sidebar";
import { BillingGate } from "@/components/billing-gate";
import { TerminalBlock } from "@/components/terminal-block";
import { TwoFactorGate } from "@/components/two-factor-gate";
import { API_URL } from "@/lib/api-url";
import { authClient } from "@/lib/auth-client";

// Mirrors gnt.routers.rules._serialize's response shape exactly
// (apps/api/src/gnt/routers/rules.py) -- only the fields this page
// actually renders.
export type Rule = {
  id: string;
  title: string;
  status: "draft" | "in_review" | "pending_merge" | "approved" | "deprecated";
  confidence: number;
  source: string | null;
  tags: string[];
  created_at: string;
  freshness: { age_days: number; stale: boolean } | null;
};

// Mirrors gap_tracking.list_top_gaps's row shape.
export type Gap = { tool: string; query_text: string; hit_count: number; last_seen: string };

const PREBRAIN_LINE = "$ gnt prebrain";

function tagGroups(rules: Rule[]): Array<{ tag: string; rules: Rule[] }> {
  const byTag = new Map<string, Rule[]>();
  for (const rule of rules) {
    const tags = rule.tags.length > 0 ? rule.tags : ["Uncategorized"];
    for (const tag of tags) {
      const existing = byTag.get(tag);
      if (existing) existing.push(rule);
      else byTag.set(tag, [rule]);
    }
  }
  return Array.from(byTag.entries())
    .map(([tag, groupRules]) => ({ tag, rules: groupRules }))
    .sort((a, b) => b.rules.length - a.rules.length);
}

// Session/auth gating is handled server-side (see page.tsx and
// app/(account)/layout.tsx) -- page.tsx also fetches /v1/rules and
// /v1/gaps itself and passes them down as initialRules/initialGaps, so
// the common case renders real content on arrival instead of mounting to
// an empty shell. The effects below only run when that came back null
// (no server token, apps/api hiccup) -- same fetch-and-render-with-a-
// specific-error-message path this page always had, now just a fallback
// instead of the only path. "Knowledge by category" and "Recent
// knowledge" are built entirely off GET /v1/rules (the same rules `gnt
// prebrain`/`gnt review` produce, filtered to approved -- that's the
// org's real, live knowledge, not a placeholder graph); "Blind spots" off
// GET /v1/gaps (search_rules calls that came back empty -- literally
// where the brain has holes). No literal node-link graph rendering here:
// this app's terminal-native design system (0-radius, plain monospace
// cards, no charting library) has no existing idiom for one, and
// grouping the same real data by tag reads as the graph's clusters
// without introducing a second visual dialect or a new dependency.
export function OverviewClient({
  initialRules,
  initialGaps,
}: {
  initialRules: Rule[] | null;
  initialGaps: Gap[] | null;
}) {
  const [rules, setRules] = useState<Rule[] | null>(initialRules);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [loadingRules, setLoadingRules] = useState(initialRules === null);

  const [gaps, setGaps] = useState<Gap[] | null>(initialGaps);
  const [gapsError, setGapsError] = useState<string | null>(null);
  const [loadingGaps, setLoadingGaps] = useState(initialGaps === null);

  useEffect(() => {
    if (initialRules !== null) return;
    let cancelled = false;
    async function load() {
      const { data, error } = await authClient.token();
      const token = data?.token;
      if (error || !token) {
        if (!cancelled) setRulesError("Couldn't verify your session. Try signing in again.");
        if (!cancelled) setLoadingRules(false);
        return;
      }
      try {
        const res = await fetch(`${API_URL}/v1/rules`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (!res.ok) {
          setRulesError("Couldn't load your organization's knowledge. Try again in a moment.");
          return;
        }
        setRules(await res.json());
      } catch {
        if (!cancelled) setRulesError("Couldn't reach the API. Check your connection and try again.");
      } finally {
        if (!cancelled) setLoadingRules(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // initialRules is a one-time seed (see the comment above this
    // component), not a value this effect should re-run on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (initialGaps !== null) return;
    let cancelled = false;
    async function load() {
      const { data, error } = await authClient.token();
      const token = data?.token;
      if (error || !token) {
        if (!cancelled) setGapsError("Couldn't verify your session. Try signing in again.");
        if (!cancelled) setLoadingGaps(false);
        return;
      }
      try {
        const res = await fetch(`${API_URL}/v1/gaps?limit=8`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (!res.ok) {
          setGapsError("Couldn't load coverage gaps. Try again in a moment.");
          return;
        }
        setGaps(await res.json());
      } catch {
        if (!cancelled) setGapsError("Couldn't reach the API. Check your connection and try again.");
      } finally {
        if (!cancelled) setLoadingGaps(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // initialGaps is a one-time seed, same reasoning as the rules effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const approved = useMemo(() => (rules ?? []).filter((r) => r.status === "approved"), [rules]);
  const inReview = useMemo(
    () => (rules ?? []).filter((r) => r.status === "draft" || r.status === "in_review" || r.status === "pending_merge"),
    [rules],
  );
  const groups = useMemo(() => tagGroups(approved), [approved]);
  const recent = useMemo(
    () => [...approved].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 6),
    [approved],
  );

  const loading = loadingRules || loadingGaps;
  const hasError = rulesError || gapsError;
  const isEmpty = !loading && !hasError && approved.length === 0 && (gaps ?? []).length === 0;

  return (
    <>
      <TwoFactorGate />
      <BillingGate />

      <header className="flex items-center gap-3 border-b border-border px-6 py-4">
        <AccountSidebarToggle />
        <h1 className="font-mono text-lg font-semibold text-foreground">Overview</h1>
      </header>

      <main className="flex-1 p-5">
          {loading && <p className="font-mono text-sm text-muted">Loading…</p>}
          {!loading && hasError && (
            <p className="font-mono text-sm text-muted">{rulesError ?? gapsError}</p>
          )}

          {isEmpty && (
            <div className="flex w-full flex-col items-start gap-4 text-left">
              <div className="flex flex-col items-start gap-2">
                <p className="font-mono text-xs uppercase tracking-widest text-muted">Overview</p>
                <h2 className="font-mono text-2xl font-bold tracking-tight">Nothing in the brain yet.</h2>
                <p className="font-mono text-sm text-muted">
                  gnt.ai hasn&apos;t learned anything about your company yet. Run <code className="text-foreground">gnt
                  prebrain</code> in your repo to scan it and start proposing rules.
                </p>
              </div>
              <TerminalBlock lines={[PREBRAIN_LINE]} copyText={PREBRAIN_LINE} />
            </div>
          )}

          {!loading && !hasError && !isEmpty && (
            <div className="flex w-full flex-col gap-4">
              <div className="grid grid-cols-3 gap-4">
                <div className="border border-border p-4">
                  <p className="font-mono text-xs uppercase tracking-widest text-muted">Approved</p>
                  <p className="mt-1 font-mono text-2xl font-medium text-foreground">{approved.length}</p>
                </div>
                <div className="border border-border p-4">
                  <p className="font-mono text-xs uppercase tracking-widest text-muted">In review</p>
                  <p className="mt-1 font-mono text-2xl font-medium text-foreground">{inReview.length}</p>
                </div>
                <div className="border border-border p-4">
                  <p className="font-mono text-xs uppercase tracking-widest text-muted">Open gaps</p>
                  <p className="mt-1 font-mono text-2xl font-medium text-foreground">{(gaps ?? []).length}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="border border-border p-5">
                  <h2 className="font-mono text-sm font-medium text-foreground">Knowledge by category</h2>
                  {groups.length === 0 ? (
                    <p className="mt-3 font-mono text-sm text-muted">No approved rules yet.</p>
                  ) : (
                    <div className="mt-3 max-h-56 overflow-y-auto flex flex-col border border-border divide-y divide-border">
                      {groups.map((group) => (
                        <div key={group.tag} className="flex items-center justify-between gap-3 px-4 py-2.5">
                          <span className="truncate font-mono text-sm text-foreground">{group.tag}</span>
                          <span className="shrink-0 rounded-[4px] bg-surface-high px-2 py-0.5 font-mono text-xs text-muted">
                            {group.rules.length}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border border-border p-5">
                  <h2 className="font-mono text-sm font-medium text-foreground">Blind spots</h2>
                  {(gaps ?? []).length === 0 ? (
                    <p className="mt-3 font-mono text-sm text-muted">No uncovered queries recorded.</p>
                  ) : (
                    <div className="mt-3 max-h-56 overflow-y-auto flex flex-col border border-border divide-y divide-border">
                      {(gaps ?? []).map((gap) => (
                        <div
                          key={`${gap.tool}:${gap.query_text}`}
                          className="flex items-center justify-between gap-3 px-4 py-2.5"
                        >
                          <span className="truncate font-mono text-sm text-foreground">{gap.query_text}</span>
                          <span className="shrink-0 font-mono text-xs text-muted">{gap.hit_count}×</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="border border-border p-5">
                <h2 className="font-mono text-sm font-medium text-foreground">Recent knowledge</h2>
                {recent.length === 0 ? (
                  <p className="mt-3 font-mono text-sm text-muted">No approved rules yet.</p>
                ) : (
                  <div className="mt-3 max-h-64 overflow-y-auto flex flex-col border border-border divide-y divide-border">
                    {recent.map((rule) => (
                      <div key={rule.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <div className="min-w-0 flex flex-col">
                          <span className="truncate font-mono text-sm text-foreground">{rule.title}</span>
                          {rule.tags.length > 0 && (
                            <span className="truncate font-mono text-xs text-muted">{rule.tags.join(", ")}</span>
                          )}
                        </div>
                        <span
                          className={
                            rule.freshness?.stale
                              ? "shrink-0 font-mono text-xs text-error"
                              : "shrink-0 font-mono text-xs text-muted"
                          }
                        >
                          {rule.freshness?.stale ? "stale" : "fresh"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
      </main>
    </>
  );
}

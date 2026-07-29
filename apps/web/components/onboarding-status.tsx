"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL } from "@/lib/api-url";
import { authClient } from "@/lib/auth-client";

const POLL_MS = 4000;

type OnboardingStatus = {
  connected_cli: boolean;
  connected_github: boolean;
  connected_slack: boolean;
  rules_proposed: number;
  rules_approved: number;
  reached_five_rules_milestone: boolean;
};

// Founder-set success-metric threshold (5), matching
// gnt/onboarding_metrics.RULES_APPROVED_MILESTONE server-side. Kept as its
// own constant here rather than only reading reached_five_rules_milestone
// off the response, since the live count (below) needs the number too, not
// just the boolean.
const RULES_APPROVED_MILESTONE = 5;

type Step = {
  key: keyof OnboardingStatus | "rule" | "milestone";
  label: string | ((s: OnboardingStatus) => string);
  done: (s: OnboardingStatus) => boolean;
  // Whether hitting this step is required to stop polling (see poll()
  // below). The milestone step is real progress worth showing, not
  // something this page should sit polling every 4s for indefinitely --
  // PRs opened in Step 5/6 of ONBOARD_FOR_AGENTS.md can take the operator
  // an arbitrary amount of time to merge on GitHub, well past the
  // lifetime of a single /welcome visit.
  required?: boolean;
};

const STEPS: Step[] = [
  { key: "connected_cli", label: "Install & sign in", done: (s) => s.connected_cli },
  { key: "connected_github", label: "Connect GitHub", done: (s) => s.connected_github },
  { key: "connected_slack", label: "Connect Slack (optional)", done: (s) => s.connected_slack },
  { key: "rule", label: "Add your first rule", done: (s) => s.rules_proposed > 0 },
  {
    key: "milestone",
    label: (s) =>
      `${Math.min(s.rules_approved, RULES_APPROVED_MILESTONE)}/${RULES_APPROVED_MILESTONE} rules approved`,
    done: (s) => s.reached_five_rules_milestone,
    required: false,
  },
];

// /welcome's two setup paths (agent-driven or manual, see that page) both
// land on the exact same backend state -- GitHub gets connected, a CLI key
// gets minted, a rule gets proposed -- regardless of which one someone
// picks. This polls apps/api's real state (GET /v1/onboarding/status,
// extended with connected_cli for this page -- see brain.py) instead of
// leaving both paths as static text with no feedback that anything
// actually happened. Stops polling once every *required* step is done
// (see Step.required), or on the first fetch failure (not signed in,
// network hiccup, org not provisioned yet) -- same best-effort posture as
// `gnt status`'s own onboarding line, this is a nice-to-have progress
// indicator, not something the page's usefulness depends on.
export function OnboardingStatusList() {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const stopped = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (cancelled || stopped.current) return;
      try {
        const { data, error } = await authClient.token();
        const token = data?.token;
        if (error || !token) throw new Error("no session token");

        const res = await fetch(`${API_URL}/v1/onboarding/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const next = (await res.json()) as OnboardingStatus;
        if (cancelled) return;
        setStatus(next);

        if (STEPS.filter((step) => step.required !== false).every((step) => step.done(next))) {
          stopped.current = true;
          return;
        }
      } catch {
        // Best-effort -- see the function comment above. One failure just
        // means no live checklist this visit, not a broken page.
        if (!cancelled) setFailed(true);
        stopped.current = true;
        return;
      }
      setTimeout(poll, POLL_MS);
    }

    poll();
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed || !status) return null;

  // Recommended-next-step nudge -- once the prerequisites `gnt prebrain`
  // actually needs (a CLI login and a connected repo; Slack stays
  // optional) are in place but nothing's been drafted yet, point straight
  // at it instead of leaving someone who picked Path B to notice the
  // command in the terminal block on their own.
  const readyForPrebrain =
    status.connected_cli && status.connected_github && status.rules_proposed === 0;

  return (
    <div className="w-full flex flex-col gap-1.5">
      {STEPS.map((step) => {
        const done = step.done(status);
        const label = typeof step.label === "function" ? step.label(status) : step.label;
        return (
          <div key={step.key} className="flex items-center gap-2 font-mono text-sm">
            <span
              aria-hidden="true"
              className={
                done
                  ? "text-success transition-colors duration-300 ease-out-strong"
                  : "text-muted transition-colors duration-300 ease-out-strong"
              }
            >
              {done ? "[x]" : "[ ]"}
            </span>
            <span
              className={
                done
                  ? "text-foreground transition-colors duration-300 ease-out-strong"
                  : "text-muted transition-colors duration-300 ease-out-strong"
              }
            >
              {label}
            </span>
          </div>
        );
      })}
      {readyForPrebrain && (
        <p className="font-mono text-sm text-muted pt-1">
          Next: run <code className="text-foreground">gnt prebrain</code> in your repo to draft
          rules automatically.
        </p>
      )}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/api-url";
import { authClient } from "@/lib/auth-client";
import { isOnboardingComplete } from "@/lib/onboarding-complete";

// Mirrors gnt.routers.brain.onboarding_status's response shape exactly.
export type OnboardingStatus = {
  connected_cli: boolean;
  connected_github: boolean;
  connected_slack: boolean;
  rules_proposed: number;
  rules_approved: number;
  reached_five_rules_milestone: boolean;
};

// A single, un-polled fetch of the same status components/onboarding-
// status.tsx polls live on the onboarding page itself -- consumers here
// (the sidebar nav, the Overview page) only need "is it done right now
// on this load", not a live-updating checklist.
export function useOnboardingStatus() {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data, error } = await authClient.token();
      const token = data?.token;
      if (error || !token) {
        if (!cancelled) setLoading(false);
        return;
      }
      try {
        const res = await fetch(`${API_URL}/v1/onboarding/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!cancelled && res.ok) setStatus(await res.json());
      } catch {
        // Best-effort, same posture as onboarding-status.tsx's own poll --
        // a network hiccup here just means "unknown yet", not an error
        // state worth surfacing in a sidebar.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { status, loading, complete: status ? isOnboardingComplete(status) : false };
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { OnboardingFooter } from "@/components/onboarding-footer";
import { OnboardingHeader } from "@/components/onboarding-header";
import { authClient } from "@/lib/auth-client";
import type { auth } from "@/lib/auth";

type ServerSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || `org-${Date.now()}`
  );
}

// The session is already resolved server-side (see page.tsx) -- this only
// owns what's genuinely client-only: better-auth's own organization.list/
// setActive calls, which have no clean server equivalent here.
export function OnboardingOrganizationClient({
  session,
  next,
}: {
  session: ServerSession;
  next?: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Every successful sign-in/sign-up lands here first now (OTP and OAuth
  // both funnel through the same post-auth redirect — see
  // components/auth-screen.tsx), so this page can't assume "getting here
  // means you're brand new" anymore. showForm only flips true once we've
  // confirmed there's genuinely no org to fall back to.
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    // page.tsx (server-side) already redirects away before this component
    // ever mounts when session.session.activeOrganizationId is set -- this
    // effect only ever runs for a session with no active org at all.
    let cancelled = false;
    authClient.organization
      .list()
      .then(({ data: orgs }) => {
        if (cancelled) return;
        if (orgs && orgs.length > 0) {
          // Has org membership (an earlier device, or an accepted invite
          // that never got activated this session) but no active org
          // selected right now -- pick one rather than making them create a
          // second org they didn't mean to.
          authClient.organization
            .setActive({ organizationId: orgs[0].id })
            .then(() => {
              if (!cancelled) router.replace(next ?? "/welcome");
            })
            .catch(() => {
              // Worst case: they see the create-org form once when they
              // didn't need to. Better than being stuck on "Loading…"
              // forever with no way out.
              if (!cancelled) setShowForm(true);
            });
          return;
        }
        setShowForm(true);
      })
      .catch(() => {
        if (!cancelled) setShowForm(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session, router, next]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { data: org, error: createError } = await authClient.organization.create({
      name,
      slug: slugify(name),
    });
    if (createError || !org) {
      setLoading(false);
      setError(createError?.message ?? "Couldn't create your organization — try again.");
      return;
    }

    const { error: activateError } = await authClient.organization.setActive({
      organizationId: org.id,
    });
    setLoading(false);
    if (activateError) {
      setError(activateError.message ?? "Organization created, but couldn't activate it.");
      return;
    }

    // A brand-new org still needs a plan before it's really set up -- an
    // existing org (already active, handled server-side in page.tsx, or
    // found here via organization.list()) skips straight to /welcome
    // instead, since it's already been through this once. `next` (from
    // /cli-login) overrides both: that page re-checks billing itself once
    // it has its key, so send it straight back instead of detouring it
    // through /onboarding/billing too.
    router.push(next ?? "/onboarding/billing");
  }

  return (
    <div className="flex-1 flex flex-col">
      <OnboardingHeader initialSession={session} />
      <main className="flex-1 flex items-center justify-center px-6 py-16">
        {!showForm && <p className="font-mono text-sm text-muted">Loading…</p>}
        {showForm && (
          <div className="w-[440px] border border-border bg-surface rounded-none p-8">
            <div className="flex flex-col gap-1.5 mb-6">
              <h1 className="font-mono font-bold tracking-tight text-foreground text-lg">
                Name your organization
              </h1>
              <p className="text-sm text-muted">
                This is your team&apos;s workspace — you can invite others to it later.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="org-name" className="font-mono text-xs uppercase tracking-widest text-muted">
                  Organization name
                </label>
                <input
                  id="org-name"
                  type="text"
                  required
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="rounded-[4px] bg-surface-low border border-border text-foreground placeholder:text-muted/50 focus:border-foreground/40 transition-colors duration-150 ease-out-strong px-3 py-2 text-sm outline-none"
                />
              </div>

              {error && <p className="text-sm text-error">{error}</p>}

              <button
                type="submit"
                disabled={loading}
                className="rounded-[4px] bg-accent-brand text-accent-brand-foreground font-mono text-sm font-medium hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong py-2 disabled:opacity-50"
              >
                {loading ? "Creating..." : "Continue"}
              </button>
            </form>
          </div>
        )}
      </main>
      <OnboardingFooter />
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { MarketingHeader } from "@/components/marketing-header";
import { authClient, useSession } from "@/lib/auth-client";

type FetchState =
  | { kind: "loading" }
  | { kind: "ready"; organizationName: string }
  | { kind: "error"; message: string };

export default function AcceptInvitationPage() {
  const { id } = useParams<{ id: string }>();
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const [fetchState, setFetchState] = useState<FetchState>({ kind: "loading" });
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    // Signed-out is derived straight from session state below, not synced
    // into fetchState here -- this effect only ever fires the invitation
    // lookup, so setFetchState only runs inside the async callback, never
    // synchronously in the effect body.
    if (isPending || !session) return;

    let cancelled = false;
    authClient.organization.getInvitation({ query: { id } }).then(({ data, error: fetchError }) => {
      if (cancelled) return;
      if (fetchError || !data) {
        setFetchState({
          kind: "error",
          message: fetchError?.message ?? "This invitation link isn't valid or has expired.",
        });
        return;
      }
      setFetchState({ kind: "ready", organizationName: data.organizationName });
    });
    return () => {
      cancelled = true;
    };
  }, [isPending, session, id]);

  async function handleAccept() {
    setAccepting(true);
    const { error: acceptError } = await authClient.organization.acceptInvitation({ invitationId: id });
    if (acceptError) {
      setAccepting(false);
      setFetchState({ kind: "error", message: acceptError.message ?? "Couldn't accept this invitation — try again." });
      return;
    }
    router.push("/welcome");
  }

  return (
    <div className="flex-1 flex flex-col">
      <MarketingHeader />
      <main className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-3">
        {isPending && <p className="font-mono text-sm text-muted">Loading invitation…</p>}

        {!isPending && !session && (
          <div className="flex flex-col items-center gap-2 max-w-sm">
            <p className="font-mono text-sm text-foreground">Sign in to accept this invitation.</p>
            <p className="font-mono text-sm text-muted">
              Once you&apos;re signed in, open this link again to accept.
            </p>
            <div className="flex gap-4 mt-2">
              <Link
                href="/sign-in"
                className="font-mono text-sm text-foreground underline hover:opacity-80 transition-opacity duration-150 ease-out-strong"
              >
                Sign in
              </Link>
              <Link
                href="/sign-up"
                className="font-mono text-sm text-foreground underline hover:opacity-80 transition-opacity duration-150 ease-out-strong"
              >
                Sign up
              </Link>
            </div>
          </div>
        )}

        {!isPending && session && fetchState.kind === "loading" && (
          <p className="font-mono text-sm text-muted">Loading invitation…</p>
        )}

        {!isPending && session && fetchState.kind === "ready" && (
          <div className="flex flex-col items-center gap-3 max-w-sm">
            <p className="font-mono text-sm text-foreground">
              Join <strong>{fetchState.organizationName}</strong> on gnt.ai?
            </p>
            <button
              type="button"
              onClick={handleAccept}
              disabled={accepting}
              className="rounded-[4px] bg-accent-brand text-accent-brand-foreground font-mono text-sm font-medium px-5 py-2 hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong disabled:opacity-50"
            >
              {accepting ? "Joining..." : "Accept invitation"}
            </button>
          </div>
        )}

        {!isPending && session && fetchState.kind === "error" && (
          <p className="font-mono text-sm text-muted max-w-sm">{fetchState.message}</p>
        )}
      </main>
    </div>
  );
}

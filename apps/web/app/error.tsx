"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { MarketingHeader } from "@/components/marketing-header";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Next's own error.tsx convention -- there's no error-reporting service
  // wired into apps/web yet, so this at least gets the failure into
  // whatever's already capturing browser console output.
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex-1 flex flex-col">
      <MarketingHeader />
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-16 gap-6 text-center">
        <div className="w-full max-w-md text-left border border-border bg-surface-low shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] px-5 py-4 font-mono text-sm">
          <p>
            <span className="text-muted">$ </span>run this-page
          </p>
          <p className="text-muted">
            {error.digest ? `error: ${error.digest}` : "error: something went wrong"}
            <span aria-hidden="true" className="cursor-blink text-foreground">
              ▋
            </span>
          </p>
        </div>
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Error</p>
        <h1 className="font-mono text-2xl font-bold tracking-tight">Something broke on our end.</h1>
        <p className="font-mono text-sm text-muted max-w-sm">
          The request failed. Try again, or head back and pick up where you left off.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-4">
          <button
            type="button"
            onClick={reset}
            className="group inline-flex items-center gap-2 rounded-[6px] bg-accent-brand px-4 py-3 font-mono text-sm font-bold text-accent-brand-foreground hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong"
          >
            Try again
          </button>
          <Link
            href="/"
            className="group inline-flex items-center gap-2 font-mono text-sm text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
          >
            Back to gnt.ai
            <ArrowRight className="h-4 w-4 transition-transform duration-150 ease-out-strong group-hover:translate-x-0.5" />
          </Link>
        </div>
      </main>
    </div>
  );
}

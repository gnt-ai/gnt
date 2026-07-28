import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { MarketingHeader } from "@/components/marketing-header";

export default function NotFound() {
  return (
    <div className="flex-1 flex flex-col">
      <MarketingHeader />
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-16 gap-6 text-center">
        <div className="w-full max-w-md text-left border border-border bg-surface-low shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] px-5 py-4 font-mono text-sm">
          <p>
            <span className="text-muted">$ </span>cd this-page
          </p>
          <p className="text-muted">
            -bash: cd: this-page: No such file or directory
            <span aria-hidden="true" className="cursor-blink text-foreground">
              ▋
            </span>
          </p>
        </div>
        <p className="font-mono text-xs uppercase tracking-widest text-muted">404</p>
        <h1 className="font-mono text-2xl font-bold tracking-tight">This route doesn&apos;t exist.</h1>
        <p className="font-mono text-sm text-muted max-w-sm">
          Maybe it moved, maybe it never merged. Either way, nothing&apos;s here.
        </p>
        <Link
          href="/"
          className="group inline-flex items-center gap-2 rounded-[6px] bg-accent-brand px-4 py-3 font-mono text-sm font-bold text-accent-brand-foreground hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong"
        >
          Back to gnt.ai
          <ArrowRight className="h-4 w-4 transition-transform duration-150 ease-out-strong group-hover:translate-x-0.5" />
        </Link>
      </main>
    </div>
  );
}

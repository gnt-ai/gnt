import Link from "next/link";

// Minimal footer for signed-in account pages -- deliberately not the
// marketing site's 3-column link grid + copyright row (see page.tsx's own
// <footer>). There's nothing to market to someone already inside their
// account; this is just a way back out to the public site and the docs,
// plus the copyright line.
export function DashboardFooter() {
  return (
    <footer className="flex justify-center border-t border-border">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-6 py-6 max-w-3xl w-full sm:border-x sm:border-border font-mono text-xs text-muted">
        <p>© 2026 gnt.ai</p>
        <div className="flex items-center gap-4">
          <Link href="/" className="hover:text-foreground transition-colors duration-150 ease-out-strong">
            gnt.ai
          </Link>
          <Link href="/docs" className="hover:text-foreground transition-colors duration-150 ease-out-strong">
            Docs
          </Link>
        </div>
      </div>
    </footer>
  );
}

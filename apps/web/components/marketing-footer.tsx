import Link from "next/link";

// Same footer everywhere -- previously only the homepage had one, so
// landing on docs/changelog/privacy/terms directly (or navigating there
// from the homepage) had no way back to the rest of the site short of
// the header's own nav links. Horizontal hairline-separated link grid
// over a top rule, bottom copyright + utility row, per the reference's
// footer spec. Same max-w-3xl + sm:border-x as every page's own content
// frame -- the vertical hairlines have to land in the same place as the
// rest of the page, not just through <main>.
//
export function MarketingFooter() {
  return (
    <footer className="flex justify-center border-t border-border">
      <div className="w-full max-w-3xl sm:border-x sm:border-border">
        <div className="grid grid-cols-4 divide-x divide-border border-b border-border">
          <Link
            href="/docs"
            className="px-6 py-6 text-center font-mono text-sm text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
          >
            Docs
          </Link>
          <Link
            href="/pricing"
            className="px-6 py-6 text-center font-mono text-sm text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
          >
            Pricing
          </Link>
          <Link
            href="/changelog"
            className="px-6 py-6 text-center font-mono text-sm text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
          >
            Changelog
          </Link>
          <Link
            href="https://github.com/gnt-ai/gnt"
            target="_blank"
            rel="noopener noreferrer"
            className="px-6 py-6 text-center font-mono text-sm text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
          >
            GitHub
          </Link>
        </div>
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-6 py-6">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-muted">
            <p>© 2026 gnt.ai</p>
            <Link
              href="https://github.com/gnt-ai/gnt/blob/main/docs/self-hosting/README.md"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground transition-colors duration-150 ease-out-strong"
            >
              Self-host
            </Link>
            <Link
              href="https://github.com/gnt-ai/gnt/blob/main/LICENSE"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground transition-colors duration-150 ease-out-strong"
            >
              License
            </Link>
            <Link href="/privacy" className="hover:text-foreground transition-colors duration-150 ease-out-strong">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-foreground transition-colors duration-150 ease-out-strong">
              Terms
            </Link>
          </div>
          <div className="flex items-center gap-4 font-mono text-sm text-muted">
            <Link href="/sign-in" className="hover:text-foreground transition-colors duration-150 ease-out-strong">
              Sign in
            </Link>
            <Link href="/sign-up" className="hover:text-foreground transition-colors duration-150 ease-out-strong">
              Sign up
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

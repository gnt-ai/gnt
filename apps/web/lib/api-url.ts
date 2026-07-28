// Single source of truth for the API origin every client-side fetch (plus
// docs/page.tsx's own display copy) targets. NEXT_PUBLIC_API_URL was
// missing from Vercel's production environment for this app's entire
// history until it was found and fixed live -- every fetch silently tried
// an unreachable http://localhost:8000 from real visitors' browsers, and
// next.config.ts's CSP connect-src quietly degraded to 'self' + localhost
// only as a result. Six different files each carried their own copy of
// this fallback (five agreeing on localhost:8000, one on the real
// production origin), so a repeat of that misconfiguration would have
// failed inconsistently instead of obviously. Throwing here in production
// turns it into an immediate build failure instead of a silent runtime
// one. Falls back to the real production origin in dev -- matching the
// CLI's own default (apps/cli/src/config.ts) -- rather than localhost, so
// a contributor without .env.local fully set up sees real data instead of
// a guaranteed connection-refused error.
function resolveApiUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "NEXT_PUBLIC_API_URL is not set -- every client-side fetch to the API would fail silently. Set it in Vercel's environment variables.",
    );
  }
  return "https://api.gntai.dev";
}

export const API_URL = resolveApiUrl();

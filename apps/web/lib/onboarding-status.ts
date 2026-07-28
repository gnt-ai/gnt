import { cache } from "react";
import { db } from "@/lib/auth";
import { isOnboardingComplete } from "@/lib/onboarding-complete";

// Server-side, no-network-hop version of what GET /v1/onboarding/status
// computes (apps/api/src/gnt/routers/brain.py) -- same reasoning as
// billing-status.ts's own isOrgEntitledForWeb: reads the same physical
// Postgres apps/api's Alembic migrations own directly, instead of
// round-tripping through a server-minted token and a fetch, so
// /overview can redirect before rendering anything instead of flashing
// real content first.
//
// cache()'d for the same reason getServerSession is (lib/auth.ts):
// app/(account)/layout.tsx and overview/page.tsx both call this once per
// navigation to /overview, for two genuinely different reasons (sidebar
// state vs. the page's own redirect gate -- see layout.tsx's comment), so
// without cache() that's two real round trips to Postgres per nav instead
// of one. The two queries within a single call are independent of each
// other, so they run concurrently rather than one after the other.
export const isOnboardingCompleteForWeb = cache(async (orgId: string): Promise<boolean> => {
  const [{ rows: cliRows }, { rows: eventRows }] = await Promise.all([
    db.query("select count(*)::int as count from mcp_api_keys where org_id = $1 and key_type = 'cli'", [orgId]),
    db.query("select event_type, count(*)::int as count from onboarding_events where org_id = $1 group by event_type", [
      orgId,
    ]),
  ]);
  const counts: Record<string, number> = Object.fromEntries(
    eventRows.map((row: { event_type: string; count: number }) => [row.event_type, row.count]),
  );
  return isOnboardingComplete({
    connected_cli: cliRows[0].count > 0,
    connected_github: (counts.github_connected ?? 0) > 0,
    rules_proposed: counts.rule_proposed ?? 0,
  });
});

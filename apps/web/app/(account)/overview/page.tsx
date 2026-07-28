import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { isOnboardingCompleteForWeb } from "@/lib/onboarding-status";
import { fetchServerApi } from "@/lib/server-api";
import { OverviewClient, type Gap, type Rule } from "./overview-client";

// Gated on onboarding actually being done (see lib/onboarding-status.ts
// for the bar) -- checked server-side, before rendering anything, so
// typing /overview directly mid-onboarding bounces back to /welcome
// instead of flashing an empty "brain" page first. AccountSidebar's own
// client-side check (lib/use-onboarding-status.ts) is what keeps the nav
// link itself from appearing before this point; this is the real gate.
export default async function OverviewPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const orgId = session.session.activeOrganizationId;
  if (!orgId || !(await isOnboardingCompleteForWeb(orgId))) redirect("/welcome");

  // Fetched here, in parallel, so the page arrives with real content
  // instead of OverviewClient mounting to an empty shell and mint-fetching
  // both of these itself. Either can come back null (no token, apps/api
  // hiccup) -- OverviewClient falls back to its own client-side fetch (and
  // its own error copy) in that case, same as before this existed.
  const [rules, gaps] = await Promise.all([
    fetchServerApi<Rule[]>("/v1/rules"),
    fetchServerApi<Gap[]>("/v1/gaps?limit=8"),
  ]);
  return <OverviewClient initialRules={rules} initialGaps={gaps} />;
}

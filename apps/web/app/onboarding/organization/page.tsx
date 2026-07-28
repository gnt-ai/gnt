import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { isOrgEntitledForWeb } from "@/lib/billing-status";
import { OnboardingOrganizationClient } from "./onboarding-organization-client";

// Only ever set by /cli-login, whose own key-minting call 403s with "no
// active organization on session" for a brand-new signup -- a relative
// path only (never "//host", which browsers treat as protocol-relative)
// so this can't be turned into an open redirect.
function safeNext(raw: string | undefined): string | undefined {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : undefined;
}

export default async function OnboardingOrganizationPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const next = safeNext((await searchParams).next);
  // A returning user with an already-active org used to land here, flash
  // this page's own client-side redirect effect, and only then bounce to
  // /welcome -- which itself flashed its "set up your team" content
  // before BillingGate's client-side check caught an unpaid org and
  // redirected again. Checking server-side, before anything renders,
  // means an unpaid org goes straight to billing and a paid one goes
  // straight to welcome -- no flash of the wrong page either way.
  const orgId = session.session.activeOrganizationId;
  if (orgId) {
    // cli-login already re-checks billing itself once it has its key (see
    // that page's own comment), so a `next` back to it skips the billing
    // detour entirely instead of sending the CLI flow through it twice.
    redirect(next ?? (await isOrgEntitledForWeb(orgId) ? "/welcome" : "/onboarding/billing"));
  }
  return <OnboardingOrganizationClient session={session} next={next} />;
}

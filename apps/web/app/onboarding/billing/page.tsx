import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { isOrgEntitledForWeb } from "@/lib/billing-status";
import { OnboardingBillingClient } from "./onboarding-billing-client";

export default async function OnboardingBillingPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  // Already paid (or already trialing) -- there's nothing to pick here
  // that isn't better handled from settings/billing, and showing the
  // trial picker again to someone who already converted reads as broken,
  // not helpful.
  const orgId = session.session.activeOrganizationId;
  if (orgId && (await isOrgEntitledForWeb(orgId))) redirect("/welcome");
  return <OnboardingBillingClient session={session} />;
}

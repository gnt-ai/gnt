import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { OrgDetailClient } from "./org-detail-client";

// Same "just gate on signed-in, let the API be the real platform-admin
// gate" posture as ../page.tsx -- see OrgDetailClient's own comment.
export default async function PlatformAdminOrgPage({ params }: { params: Promise<{ orgId: string }> }) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const { orgId } = await params;
  return <OrgDetailClient orgId={orgId} />;
}

import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { OrgListClient } from "./org-list-client";

// The platform-admin allowlist check lives entirely in apps/api (this
// page has no server-side equivalent of it, deliberately -- see
// OrgListClient's own comment). This only gates on "is anyone signed in
// at all", same bar as every other account page's page.tsx.
export default async function PlatformAdminPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  return <OrgListClient />;
}

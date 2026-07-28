import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { SecuritySettingsClient } from "./security-settings-client";

export default async function SecuritySettingsPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  return <SecuritySettingsClient session={session} />;
}

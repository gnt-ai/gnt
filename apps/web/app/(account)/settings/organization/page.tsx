import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth, getServerSession } from "@/lib/auth";
import { fetchServerApi } from "@/lib/server-api";
import {
  OrganizationSettingsClient,
  type FullOrganization,
  type GithubStatus,
  type LinearStatus,
  type NotionStatus,
} from "./organization-settings-client";

export default async function OrganizationSettingsPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const orgId = session.session.activeOrganizationId;
  // Fetched here, in parallel, so the page arrives with the members list,
  // connector cards, and rename form already filled in instead of
  // OrganizationSettingsClient mounting to a single full-page "Loading…"
  // (the org fetch) followed by three more per-connector ones. Any of
  // these can come back null (no active org, no token, apps/api hiccup)
  // -- the client component falls back to its own client-side fetch (and
  // its own error copy, or authClient.useActiveOrganization()'s own
  // pending state for the org itself) in that case, same as before this
  // existed. auth.api.getFullOrganization is the same call
  // app/api/cli/org/route.ts already makes for the CLI's `gnt org` --
  // reusing Better Auth's own org lookup here too instead of a second one.
  const [org, githubStatus, notionStatus, linearStatus] = await Promise.all([
    orgId
      ? (auth.api.getFullOrganization({ query: { organizationId: orgId }, headers: await headers() }) as Promise<FullOrganization | null>)
      : Promise.resolve(null),
    fetchServerApi<GithubStatus>("/v1/settings/github"),
    fetchServerApi<NotionStatus>("/v1/notion/status"),
    fetchServerApi<LinearStatus>("/v1/linear/status"),
  ]);
  return (
    <OrganizationSettingsClient
      session={session}
      initialOrg={org}
      initialGithubStatus={githubStatus}
      initialNotionStatus={notionStatus}
      initialLinearStatus={linearStatus}
    />
  );
}

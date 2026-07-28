import { auth } from "@/lib/auth";
import { resolveCliKeyOrg, withOrgAdminSession } from "@/lib/cli-org-bridge";

// GET /api/cli/org -- org name, members, pending invitations, for `gnt org`.
// Bridges a CLI cli-key into a real (short-lived) Better Auth admin
// session so this reuses Better Auth's own getFullOrganization instead
// of re-querying the org tables by hand -- see lib/cli-org-bridge.ts.
export async function GET(request: Request) {
  const orgId = await resolveCliKeyOrg(request.headers.get("authorization"));
  if (!orgId) {
    return Response.json({ error: "invalid or non-admin cli-key" }, { status: 401 });
  }

  const org = await withOrgAdminSession(orgId, (headers) =>
    auth.api.getFullOrganization({ query: { organizationId: orgId }, headers }),
  );
  if (!org) {
    return Response.json({ error: "organization not found" }, { status: 404 });
  }

  return Response.json({
    id: org.id,
    name: org.name,
    members: org.members.map((m) => ({ email: m.user.email, name: m.user.name, role: m.role })),
    invitations: org.invitations
      .filter((i) => i.status === "pending")
      .map((i) => ({ email: i.email, role: i.role })),
  });
}

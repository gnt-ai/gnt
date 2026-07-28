import { APIError } from "better-auth/api";
import { auth } from "@/lib/auth";
import { resolveCliKeyOrg, withOrgAdminSession } from "@/lib/cli-org-bridge";

// POST /api/cli/org/remove { email } -- for `gnt org remove <email>`.
// Better Auth's removeMember takes an id OR an email directly, so the
// CLI never needs to know a member's internal id.
export async function POST(request: Request) {
  const orgId = await resolveCliKeyOrg(request.headers.get("authorization"));
  if (!orgId) {
    return Response.json({ error: "invalid or non-admin cli-key" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!email) {
    return Response.json({ error: "email is required" }, { status: 400 });
  }

  try {
    await withOrgAdminSession(orgId, (headers) =>
      auth.api.removeMember({ body: { memberIdOrEmail: email, organizationId: orgId }, headers }),
    );
  } catch (err) {
    // See invite/route.ts's identical catch for why only APIError's own
    // (curated, user-facing) message is ever returned to the client.
    const message = err instanceof APIError ? err.message : "couldn't remove that member";
    return Response.json({ error: message }, { status: 400 });
  }

  return Response.json({ email });
}

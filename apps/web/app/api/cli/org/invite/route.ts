import { APIError } from "better-auth/api";
import { auth } from "@/lib/auth";
import { resolveCliKeyOrg, withOrgAdminSession } from "@/lib/cli-org-bridge";

// POST /api/cli/org/invite { email, role? } -- for `gnt org invite <email>`.
// role defaults to "member", matching the web settings page's default.
export async function POST(request: Request) {
  const orgId = await resolveCliKeyOrg(request.headers.get("authorization"));
  if (!orgId) {
    return Response.json({ error: "invalid or non-admin cli-key" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const role = body?.role === "admin" ? "admin" : "member";
  if (!email) {
    return Response.json({ error: "email is required" }, { status: 400 });
  }

  try {
    await withOrgAdminSession(orgId, (headers) =>
      auth.api.createInvitation({ body: { email, role, organizationId: orgId }, headers }),
    );
  } catch (err) {
    // APIError messages are Better Auth's own curated, user-facing text
    // (e.g. "already a member of this organization") -- anything else
    // (a DB hiccup, a bug in withOrgAdminSession) is not written to be
    // read by a client, so it gets a generic message instead of whatever
    // internal detail err.message happens to contain.
    const message = err instanceof APIError ? err.message : "couldn't send that invite";
    return Response.json({ error: message }, { status: 400 });
  }

  return Response.json({ email, role });
}

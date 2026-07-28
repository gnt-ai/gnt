import { APIError } from "better-auth/api";
import { auth } from "@/lib/auth";
import { resolveCliKeyOrg, withOrgAdminSession } from "@/lib/cli-org-bridge";

// POST /api/cli/org/rename { name } -- for `gnt org rename <name>`.
export async function POST(request: Request) {
  const orgId = await resolveCliKeyOrg(request.headers.get("authorization"));
  if (!orgId) {
    return Response.json({ error: "invalid or non-admin cli-key" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }

  try {
    await withOrgAdminSession(orgId, (headers) =>
      auth.api.updateOrganization({ body: { organizationId: orgId, data: { name } }, headers }),
    );
  } catch (err) {
    // See invite/route.ts's identical catch for why only APIError's own
    // (curated, user-facing) message is ever returned to the client.
    const message = err instanceof APIError ? err.message : "couldn't rename the organization";
    return Response.json({ error: message }, { status: 400 });
  }

  return Response.json({ name });
}

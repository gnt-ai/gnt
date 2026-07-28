import { API_URL } from "@/lib/api-url";
import { auth, db } from "@/lib/auth";

// Verifies the caller's cli-key against apps/api (the only place that
// knows how to resolve/expire/revoke one -- see auth/api_key.py) and
// requires admin standing, matching every other org-management action's
// gate. Returns the org id the key is scoped to, or null for anything
// that isn't a valid admin-capable cli-key.
export async function resolveCliKeyOrg(authHeader: string | null): Promise<string | null> {
  if (!authHeader) return null;
  const res = await fetch(`${API_URL}/v1/whoami`, { headers: { Authorization: authHeader } });
  if (!res.ok) return null;
  const body = await res.json();
  return typeof body.org_id === "string" ? body.org_id : null;
}

// A cli-key carries no real Better Auth user identity of its own (see
// auth/better_auth.py's OrgContext.user_id comment) -- org-management
// actions taken through the CLI act as one of the target org's own real
// admins instead of a synthetic identity, the same "org-scoped, not tied
// to a person" tradeoff this codebase already accepts for API-key-
// authenticated captures. Prefers the owner (always exists, always
// admin-capable) over an arbitrary admin.
async function actingAdminUserId(orgId: string): Promise<string | null> {
  const { rows } = await db.query(
    `select "userId" from "member" where "organizationId" = $1 order by (role = 'owner') desc limit 1`,
    [orgId],
  );
  return rows[0]?.userId ?? null;
}

// Mints a short-lived (60s) session for one of orgId's real admins and
// runs fn with an Authorization: Bearer header for it -- lets
// auth.api.* organization endpoints run their own real role/permission
// checks instead of this file reimplementing them. See lib/auth.ts's
// bearer() plugin comment for why Bearer, not a signed cookie: there's no
// browser here to hold one. Always deletes the session again afterward,
// not just left to expire -- it's a working credential for its whole 60s
// otherwise.
export async function withOrgAdminSession<T>(
  orgId: string,
  fn: (headers: Headers) => Promise<T>,
): Promise<T> {
  const userId = await actingAdminUserId(orgId);
  if (!userId) throw new Error(`no admin member found for org ${orgId}`);

  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(
    userId,
    false,
    { expiresAt: new Date(Date.now() + 60_000) },
    true,
  );
  const headers = new Headers({ Authorization: `Bearer ${session.token}` });
  try {
    return await fn(headers);
  } finally {
    await ctx.internalAdapter.deleteSession(session.token).catch(() => {});
  }
}

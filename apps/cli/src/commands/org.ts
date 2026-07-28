import { WEB_URL } from "../config.js";
import { loadApiKey } from "../credentials.js";
import { fail, keyValueLines, muted, ok, text } from "../theme.js";

// The org's name/members/invitations live in apps/web's Better Auth
// tables, not apps/api -- these routes are the CLI-facing bridge (see
// apps/web/app/api/cli/org/*'s own comments), same cli-key this CLI
// already stores for everything else.
async function orgFetch(path: string, init?: RequestInit): Promise<Response> {
  const key = loadApiKey();
  return fetch(`${WEB_URL}/api/cli/org${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...init?.headers },
  });
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : `${fallback} (${res.status}).`;
}

export async function orgShow(): Promise<void> {
  const res = await orgFetch("");
  if (!res.ok) {
    console.error(fail(await errorMessage(res, "Failed to fetch organization")));
    process.exit(1);
  }
  const org: {
    name: string;
    members: Array<{ email: string; role: string }>;
    invitations: Array<{ email: string; role: string }>;
  } = await res.json();

  console.log(text(org.name));
  console.log();
  console.log(muted(`Members (${org.members.length})`));
  for (const line of keyValueLines(org.members.map((m) => [m.email, m.role]))) {
    console.log(line);
  }
  if (org.invitations.length > 0) {
    console.log();
    console.log(muted(`Pending invitations (${org.invitations.length})`));
    for (const line of keyValueLines(org.invitations.map((i) => [i.email, i.role]))) {
      console.log(line);
    }
  }
}

export async function orgRename(name: string): Promise<void> {
  const res = await orgFetch("/rename", { method: "POST", body: JSON.stringify({ name }) });
  if (!res.ok) {
    console.error(fail(await errorMessage(res, "Failed to rename the organization")));
    process.exit(1);
  }
  console.log(ok(`Renamed to "${name}".`));
}

export async function orgInvite(email: string, options: { role?: string }): Promise<void> {
  const role = options.role === "admin" ? "admin" : "member";
  const res = await orgFetch("/invite", { method: "POST", body: JSON.stringify({ email, role }) });
  if (!res.ok) {
    console.error(fail(await errorMessage(res, `Failed to invite ${email}`)));
    process.exit(1);
  }
  console.log(ok(`Invited ${email} as ${role}.`));
}

export async function orgRemove(email: string): Promise<void> {
  const res = await orgFetch("/remove", { method: "POST", body: JSON.stringify({ email }) });
  if (!res.ok) {
    console.error(fail(await errorMessage(res, `Failed to remove ${email}`)));
    process.exit(1);
  }
  console.log(ok(`Removed ${email}.`));
}

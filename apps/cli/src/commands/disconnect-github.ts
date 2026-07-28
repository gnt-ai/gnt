// `gnt disconnect github`: the missing counterpart to connect-github.ts.
// apps/api/src/gnt/routers/github.py already exposes DELETE /v1/settings/github
// (disconnect_github, require_admin-gated) -- this just wires the CLI up to
// it, same fetch-with-Bearer-key shape connect-github.ts already uses.
//
// GET before DELETE isn't required by the API (DELETE already 404s cleanly
// when nothing is connected), but it's the only way this command can name
// the repo it's about to remove in its "confirmation of what will be
// removed" message -- the DELETE response itself is a bare 204, no body.
// No TTY/y-N gate on top of that: disconnectAirtable (connect-airtable.ts)
// sets the precedent that a local/remote token removal in this CLI reports
// what it did rather than asking first, and this follows it.
import { API_URL } from "../config.js";
import { loadApiKey } from "../credentials.js";
import { fail, muted, ok } from "../theme.js";

export async function disconnectGithub(): Promise<void> {
  const key = loadApiKey();
  const headers = { Authorization: `Bearer ${key}` };

  let getRes: Response;
  try {
    getRes = await fetch(`${API_URL}/v1/settings/github`, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    console.error(fail(`Failed to reach ${API_URL}: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  }
  if (!getRes.ok) {
    const body = await getRes.json().catch(() => null);
    console.error(fail(`Failed to look up the current connection (${getRes.status}): ${body?.detail ?? "unknown error"}`));
    process.exit(1);
  }
  const current = await getRes.json();
  if (!current.connected) {
    console.log(muted("No GitHub connection to disconnect."));
    return;
  }

  let delRes: Response;
  try {
    delRes = await fetch(`${API_URL}/v1/settings/github`, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error(fail(`Failed to reach ${API_URL}: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  }
  if (delRes.status === 404) {
    console.log(muted("No GitHub connection to disconnect."));
    return;
  }
  if (!delRes.ok) {
    const body = await delRes.json().catch(() => null);
    console.error(fail(`Failed to disconnect (${delRes.status}): ${body?.detail ?? "unknown error"}`));
    process.exit(1);
  }
  // App-connected orgs never had a stored token to begin with (installation
  // tokens are minted per-operation, never persisted -- see
  // apps/api/src/gnt/github/app_auth.py) -- the copy says so instead of
  // claiming to remove something that was never there.
  console.log(
    ok(
      current.connection_type === "app"
        ? `Disconnected ${current.repo_url}. The GitHub App installation has been revoked.`
        : `Disconnected ${current.repo_url}. The stored token and repo link have been removed.`,
    ),
  );
}

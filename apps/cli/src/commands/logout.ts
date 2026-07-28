import { API_URL } from "../config.js";
import { clearCredentials, tryLoadCredentials } from "../credentials.js";
import { dim, fail, ok, text } from "../theme.js";

// Best-effort server-side revoke of the key being logged out of. Runs
// before clearCredentials so it still has the key to authenticate with,
// but its outcome never blocks the local clear below -- a customer must
// never be stuck unable to log out just because the network or the API
// is down. 400 means "already revoked", which isn't worth alarming about.
async function tryRevokeServerSide(apiKey: string, keyId: string): Promise<void> {
  try {
    const res = await fetch(`${API_URL}/v1/settings/cli-keys/${keyId}/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok && res.status !== 400) {
      console.log(dim(`Couldn't revoke the key server-side (${res.status}) — clearing local credentials anyway.`));
    }
  } catch {
    console.log(fail("Couldn't reach the server to revoke the key — clearing local credentials anyway."));
  }
}

export async function logout(): Promise<void> {
  const creds = tryLoadCredentials();

  if (creds?.keyId) {
    await tryRevokeServerSide(creds.apiKey, creds.keyId);
  } else if (creds) {
    console.log(
      dim("No key id on file for this session — only clearing local credentials. Log in again to get server-side revocation next time."),
    );
  }

  const cleared = clearCredentials();
  console.log(
    cleared
      ? ok("Logged out. Credentials removed from ~/.gnt/credentials.json")
      : text("Not logged in — nothing to do."),
  );
}

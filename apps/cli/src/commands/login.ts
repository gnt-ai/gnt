import { randomUUID } from "node:crypto";
import open from "open";
import { API_URL, WEB_URL } from "../config.js";
import { saveApiKey } from "../credentials.js";
import { dim, ok, spinner, text } from "../theme.js";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function login(): Promise<void> {
  const wait = spinner("Waiting for you to sign in…");
  try {
    const loginId = randomUUID();
    const loginUrl = `${WEB_URL}/cli-login?login_id=${loginId}`;
    // Printed so a stuck flow is debuggable, and so an old tab from a
    // previous run is never mistaken for this one — login_id is unique per
    // invocation and a stale tab's key was already consumed (or expired)
    // server-side, so it can't deliver here either way.
    console.log(dim(loginUrl));
    open(loginUrl).catch(() => {
      console.log(text("Couldn't open a browser automatically — open the URL above manually."));
    });

    // Polls a server-side pending-login slot rather than running a local
    // HTTP server for the browser to POST back to -- Chrome's Local
    // Network Access policy now gates any fetch from a public https page
    // to a loopback address behind an explicit permission prompt the user
    // has to grant first, which login.ts's old server-side CORS headers
    // alone can't satisfy (they used to be enough under the older Private
    // Network Access preflight, before Chrome added the permission
    // requirement on top). Polling the real API instead sidesteps browser
    // loopback access entirely — same handshake shape `gh auth login`/
    // `vercel login` use.
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let key: string | undefined;
    let keyId: string | null = null;
    while (Date.now() < deadline) {
      const res = await fetch(`${API_URL}/v1/settings/cli-key/poll?login_id=${loginId}`);
      if (res.status === 200) {
        const body = await res.json();
        key = body.key;
        keyId = typeof body.key_id === "string" ? body.key_id : null;
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    if (!key) throw new Error("Timed out waiting for browser login.");

    saveApiKey(key, keyId);
    wait.stop(ok("Logged in. Credentials saved to ~/.gnt/credentials.json"));
  } catch (err) {
    // Every rejection path above (timeout, malformed poll response body)
    // lands here — the spinner must stop before the error reaches
    // index.ts's top-level handler, or it's left mid-line garbling
    // whatever gets printed next.
    wait.stop();
    throw err;
  }
}

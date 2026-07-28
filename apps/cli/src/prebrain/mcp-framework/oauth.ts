// Shared OAuth 2.0 mechanics for `gnt connect <source>` -- the one-click
// replacement for a customer pasting a personal access token by hand.
// Two flows, both ending in the same OAuthCredential shape:
//
//   - runLocalRedirectOAuth: the RFC 8252 native-app pattern (`gh auth
//     login`/`vercel login` use the same one). This CLI opens the vendor's
//     own /authorize page in the customer's browser; the vendor redirects
//     the browser back to a throwaway http://127.0.0.1 server this
//     process is listening on; that server reads the auth code off the
//     real top-level navigation the browser just made. This is NOT the
//     pattern gnt login's own doc comment (commands/login.ts) rules out --
//     that comment is about a hosted https page making a background
//     fetch()/XHR to a loopback address, which Chrome's Local Network
//     Access policy now gates behind a permission prompt. A vendor's
//     OAuth redirect is a real top-level browser navigation (a 302 the
//     browser itself follows, changing the address bar), never a
//     script-initiated request from a still-open page, so that policy
//     never engages. Every OAuth-capable connector's own docs (Notion,
//     Linear, Airtable, Jira/Atlassian) confirmed a loopback redirect URI
//     works for exactly this reason -- verified per-connector, not
//     assumed here.
//   - runDeviceOAuth: RFC 8628 device authorization. No local server at
//     all -- print a short code and a URL, the customer approves in any
//     browser (even one on a different device), this process polls the
//     vendor's token endpoint until they do. Sentry's own docs recommend
//     this explicitly for CLI tools; use it wherever a vendor supports it
//     over the redirect variant, since it has no port to bind, no
//     redirect_uri to keep in sync with a vendor app registration, and
//     works over SSH/headless the redirect flow can't.
//
// Both are pure mechanism: given a vendor's endpoints/client id/scope,
// return a credential or throw. Neither one saves anything to disk --
// that's still connect.ts's job (the same validate-before-save contract
// runConnectFlow already gives a pasted token), and neither one knows
// which connector is calling it, so this file stays vendor-agnostic the
// same way mcp-connector.ts stays vendor-agnostic for stdio adapters.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import open from "open";

// What every OAuth-capable connector ends up with, regardless of which
// flow acquired it -- the shape resolveMcpToken's callers already expect
// downstream is just accessToken as a bare string (adapter.server(token),
// the Airtable REST client, etc.), so nothing past the connect flow needs
// to know OAuth was involved at all. refreshToken/expiresAt are carried
// so a later resolve-time refresh step (not wired in yet -- see this
// file's own bottom section) has something to work with once a specific
// connector's real token lifetime is known from live testing.
export interface OAuthCredential {
  accessToken: string;
  refreshToken?: string;
  /** Unix ms. Absent if the vendor's token response carried no expires_in. */
  expiresAt?: number;
  tokenType?: string;
}

// The on-disk envelope every OAuth-acquired token is stored as, through
// the exact same string-keyed saveConnectorToken/loadConnectorToken every
// pasted-token connector already uses -- same "JSON string inside the
// existing string slot" trick airtable.ts's AirtableConnectorConfig
// already established, not a new storage mechanism.
export function serializeOAuthCredential(credential: OAuthCredential): string {
  return JSON.stringify(credential);
}

// Defensive parse, same "drop what doesn't parse rather than guess" bias
// every parser in this directory keeps -- returns null for anything
// missing, malformed, or pre-dating this shape (a bare pasted token from
// before a connector switched to OAuth, for one).
export function parseOAuthCredential(raw: string | undefined): OAuthCredential | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.accessToken !== "string" || !obj.accessToken) return null;
    return {
      accessToken: obj.accessToken,
      refreshToken: typeof obj.refreshToken === "string" ? obj.refreshToken : undefined,
      expiresAt: typeof obj.expiresAt === "number" ? obj.expiresAt : undefined,
      tokenType: typeof obj.tokenType === "string" ? obj.tokenType : undefined,
    };
  } catch {
    return null;
  }
}

// RFC 7636 PKCE pair. S256 only -- every vendor checked this session
// (Notion, Linear, Airtable, Jira) documents S256 support and Airtable
// documents it as mandatory; there's no reason for this shared helper to
// also carry the weaker "plain" method just because the spec allows it.
function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

// CSRF guard for the redirect flow -- generated fresh per run, checked
// against what the vendor's redirect echoes back before the auth code is
// trusted at all.
function generateState(): string {
  return randomBytes(16).toString("base64url");
}

async function parseTokenResponse(res: Response, describeFailure: (body: unknown) => string): Promise<OAuthCredential> {
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || typeof body !== "object" || typeof (body as Record<string, unknown>).access_token !== "string") {
    throw new Error(describeFailure(body));
  }
  const obj = body as Record<string, unknown>;
  const expiresIn = typeof obj.expires_in === "number" ? obj.expires_in : undefined;
  return {
    accessToken: obj.access_token as string,
    refreshToken: typeof obj.refresh_token === "string" ? obj.refresh_token : undefined,
    expiresAt: expiresIn !== undefined ? Date.now() + expiresIn * 1000 : undefined,
    tokenType: typeof obj.token_type === "string" ? obj.token_type : undefined,
  };
}

export interface LocalRedirectOAuthConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  /**
   * Present only for vendors with no public/PKCE-only client option.
   * Shipped inside the published @gnt-ai/cli package when set, so it is
   * not a real secret (anyone who installs the CLI can read it) -- the
   * same tradeoff `gh`/`vercel`/`railway` accept for their own first-party
   * CLI OAuth apps. PKCE is what actually secures this flow; treat this
   * as an attribution string, not a security boundary.
   */
  clientSecret?: string;
  scope: string;
  /**
   * Fixed, not random -- several vendors' redirect URIs are matched
   * exact-string against what's registered in their own dev console, and
   * at least one (Notion) explicitly rejects a redirect URI whose port
   * changes between runs. Each OAuth-capable connector picks and hardcodes
   * its own port (they don't need to share one), matching whatever it
   * registered as its redirect URI's port.
   */
  port: number;
  /** Path segment of the registered redirect URI, e.g. "/callback". */
  callbackPath: string;
  /** Extra query params the vendor's own /authorize step needs beyond the standard OAuth set (rare -- most don't). */
  extraAuthParams?: Record<string, string>;
  /**
   * Called with the authorize URL right before this function tries to open
   * it. openImpl's own failure is caught and swallowed (there's often
   * nothing useful to do about a browser that won't launch), so this is
   * the only way a caller finds out the flow is stuck and gets a copyable
   * link to hand the customer -- e.g. a sandboxed shell or an SSH session
   * with no GUI to launch a browser in at all.
   */
  onAuthorizeUrl?: (url: string) => void;
  /** Test seam -- production omits it and gets the real global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam -- production omits it and gets the real `open` package. */
  openImpl?: (url: string) => Promise<unknown>;
}

const REDIRECT_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

// Runs the full authorization-code + PKCE loopback flow and returns the
// resulting credential. Throws on timeout, a vendor-reported error
// (access_denied, etc.), a state mismatch, or a failed token exchange --
// callers (connect.ts) already have a "nothing saved unless this
// succeeds" contract for a pasted token; this is the OAuth path into that
// same contract.
export async function runLocalRedirectOAuth(config: LocalRedirectOAuthConfig): Promise<OAuthCredential> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const openImpl = config.openImpl ?? ((url: string) => open(url));
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = generateState();
  const redirectUri = `http://127.0.0.1:${config.port}${config.callbackPath}`;

  const authorizeUrl = new URL(config.authorizationEndpoint);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", config.scope);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(config.extraAuthParams ?? {})) {
    authorizeUrl.searchParams.set(key, value);
  }
  config.onAuthorizeUrl?.(authorizeUrl.toString());

  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for browser authorization."));
    }, REDIRECT_WAIT_TIMEOUT_MS);

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${config.port}`);
      if (url.pathname !== config.callbackPath) {
        res.writeHead(404).end();
        return;
      }

      const returnedState = url.searchParams.get("state");
      const errorParam = url.searchParams.get("error");
      const authCode = url.searchParams.get("code");

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        errorParam || returnedState !== state || !authCode
          ? "<html><body>Something went wrong -- you can close this tab and check the terminal.</body></html>"
          : "<html><body>Connected. You can close this tab.</body></html>",
      );

      clearTimeout(timeout);
      server.close();

      if (errorParam) {
        reject(new Error(`Vendor denied authorization: ${errorParam}`));
      } else if (returnedState !== state) {
        reject(new Error("OAuth state mismatch -- possible CSRF, aborting."));
      } else if (!authCode) {
        reject(new Error("Vendor redirected back with no authorization code."));
      } else {
        resolve(authCode);
      }
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Couldn't start the local OAuth callback server on port ${config.port}: ${err.message}`));
    });

    server.listen(config.port, "127.0.0.1", () => {
      openImpl(authorizeUrl.toString()).catch(() => {
        // Same fallback commands/login.ts's own open() call already
        // takes -- the authorize URL was never printed by this function,
        // so a caller that wants a printed fallback prints
        // authorizeUrl.toString() itself before calling this.
      });
    });
  });

  const res = await fetchImpl(config.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      code_verifier: codeVerifier,
      ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
    }),
  });
  return parseTokenResponse(res, (body) => `Token exchange failed: ${JSON.stringify(body)}`);
}

export interface DeviceOAuthConfig {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scope: string;
  /** Called with the code/URL to display -- production prints them; tests capture them. */
  onPrompt: (info: { userCode: string; verificationUri: string; verificationUriComplete?: string }) => void;
  /** Test seam -- production omits it and gets the real global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam -- production omits it and gets the real `open` package. */
  openImpl?: (url: string) => Promise<unknown>;
}

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

// RFC 8628 device authorization grant. No redirect URI, no local server,
// no vendor app-registration coordination beyond a client id -- the
// customer can even approve from their phone. Preferred over
// runLocalRedirectOAuth wherever a vendor supports it.
export async function runDeviceOAuth(config: DeviceOAuthConfig): Promise<OAuthCredential> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const openImpl = config.openImpl ?? ((url: string) => open(url));

  const authRes = await fetchImpl(config.deviceAuthorizationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: config.clientId, scope: config.scope }),
  });
  const authBody = await authRes.json().catch(() => null);
  if (!authRes.ok || !authBody || typeof authBody !== "object") {
    throw new Error(`Device authorization request failed: ${JSON.stringify(authBody)}`);
  }
  const auth = authBody as Record<string, unknown>;
  const deviceCode = auth.device_code;
  const userCode = auth.user_code;
  const verificationUri = auth.verification_uri;
  const verificationUriComplete = typeof auth.verification_uri_complete === "string" ? auth.verification_uri_complete : undefined;
  if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string") {
    throw new Error(`Device authorization response missing required fields: ${JSON.stringify(auth)}`);
  }
  let intervalMs = (typeof auth.interval === "number" ? auth.interval : 5) * 1000;
  const expiresInMs = (typeof auth.expires_in === "number" ? auth.expires_in : 900) * 1000;
  const deadline = Date.now() + expiresInMs;

  config.onPrompt({ userCode, verificationUri, verificationUriComplete });
  openImpl(verificationUriComplete ?? verificationUri).catch(() => {});

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    const res = await fetchImpl(config.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: DEVICE_GRANT_TYPE, device_code: deviceCode, client_id: config.clientId }),
    });
    const body = await res.json().catch(() => null);

    if (res.ok && body && typeof body === "object" && typeof (body as Record<string, unknown>).access_token === "string") {
      return parseTokenResponse(new Response(JSON.stringify(body), { status: 200 }), () => "unreachable");
    }

    const errorCode = body && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;
    if (errorCode === "authorization_pending") continue;
    if (errorCode === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    throw new Error(`Device authorization failed: ${typeof errorCode === "string" ? errorCode : JSON.stringify(body)}`);
  }
  throw new Error("Timed out waiting for device authorization approval.");
}

// ponytail: no automatic refresh wired into resolveMcpToken/runMcpInWalk
// yet -- refreshOAuthToken exists so a connector's own connect/resolve
// code can call it once that connector's real access-token lifetime is
// known from live testing, rather than every OAuth-capable connector
// paying for async refresh plumbing before any of them need it. Add the
// resolve-time check when the first connector's token turns out to
// actually expire in practice.
export async function refreshOAuthToken(
  config: Pick<LocalRedirectOAuthConfig, "tokenEndpoint" | "clientId" | "clientSecret" | "fetchImpl">,
  refreshToken: string,
): Promise<OAuthCredential> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const res = await fetchImpl(config.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
      ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
    }),
  });
  return parseTokenResponse(res, (body) => `Token refresh failed: ${JSON.stringify(body)}`);
}

// The connect/disconnect flow an MCP-in connector's `gnt connect`/`gnt
// disconnect` command reuses, generalized from the two hand-written
// connect-notion-mcp/connect-monday-mcp commands.
//
// readMaskedToken is the exact asterisk-echoed paste those two already
// used, lifted verbatim so there is one masked-input implementation rather
// than one per connector. runConnectFlow adds the framework rule those two
// predate: validate the credential with one real read BEFORE writing it to
// disk, so a customer never ends up with a saved-but-broken token.
import { emitKeypressEvents, type Key } from "node:readline";
import { API_URL } from "../../config.js";
import { tryLoadCredentials } from "../../credentials.js";
import { dim, fail, muted, ok } from "../../theme.js";
import { loadConnectorToken, saveConnectorToken, deleteConnectorToken } from "./credentials.js";
import type { LocalRedirectOAuthConfig } from "./oauth.js";
import { runLocalRedirectOAuth } from "./oauth.js";
import type { McpInAdapter } from "./types.js";
import { validateConnection } from "./walker.js";

// Best-effort: if this adapter has a local token already, or was never
// wired to a dashboard connector (dashboardTokenPath unset), or the CLI
// isn't logged in, or the org hasn't connected this vendor from the
// dashboard yet, this returns undefined and callers fall through to
// whatever "missing token" handling they already had -- this never turns
// a real problem into a confusing extra error, it only ever adds a
// credential that would otherwise have been missing. On success the fetched
// token is cached locally via saveConnectorToken, the same store a pasted
// or CLI-OAuth'd token already lives in, so only the very first run after
// a dashboard "Connect" click ever needs the network for this.
export async function bootstrapDashboardToken<P>(
  adapter: McpInAdapter<P>,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  if (!adapter.dashboardTokenPath) return undefined;
  if (loadConnectorToken(adapter)) return undefined;

  const credentials = tryLoadCredentials();
  if (!credentials) return undefined;

  try {
    const res = await fetchImpl(`${API_URL}/v1/${adapter.dashboardTokenPath}/token`, {
      headers: { Authorization: `Bearer ${credentials.apiKey}` },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) return undefined;
    saveConnectorToken(adapter, body.access_token);
    return body.access_token;
  } catch {
    return undefined;
  }
}

// Reads a secret from an interactive terminal, echoing an asterisk per
// character so nothing sensitive lands in scrollback. commandName is only
// used in the "needs an interactive terminal" message, so each connector's
// error names its own command.
export function readMaskedToken(commandName: string, prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error(`${commandName} needs an interactive terminal.`));
      return;
    }

    let buffer = "";
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    const onKeypress = (str: string, keyInfo: Key) => {
      if (keyInfo.ctrl && keyInfo.name === "c") {
        cleanup();
        console.log();
        reject(new Error("aborted"));
        return;
      }
      if (keyInfo.name === "return" || keyInfo.name === "enter") {
        cleanup();
        console.log();
        resolve(buffer);
        return;
      }
      if (keyInfo.name === "backspace") {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      if (str && !keyInfo.ctrl) {
        buffer += str;
        process.stdout.write("*");
      }
    };

    process.stdin.on("keypress", onKeypress);
  });
}

// Shared by runConnectFlow and runOAuthConnectFlow: prove the credential
// works with one live read before it ever touches disk, then save and
// report. Identical contract regardless of how the credential was
// acquired (pasted or OAuth), so it lives in one place rather than
// re-implemented per flow.
async function validateAndSaveToken<P>(
  adapter: McpInAdapter<P>,
  token: string,
  savedHint: string,
  validate: (token: string) => Promise<void>,
): Promise<boolean> {
  console.log(muted(`Checking the ${adapter.label} connection with one read before saving...`));
  try {
    await validate(token);
  } catch (err) {
    console.error(
      fail(`Couldn't reach ${adapter.label} with that token, nothing saved: ${err instanceof Error ? err.message : String(err)}`),
    );
    return false;
  }

  saveConnectorToken(adapter, token);
  console.log(ok(`Saved. ${savedHint}`));
  console.log(dim("This token is stored only on this device (~/.gnt/mcp-tokens.json) -- gnt's servers never see it."));
  return true;
}

export interface RunConnectFlowOptions<P> {
  adapter: McpInAdapter<P>;
  // The full command name, for the interactive-terminal message ("gnt
  // connect linear-mcp").
  commandName: string;
  // Muted line printed before the prompt, telling the customer where to
  // get the token and what to share with it.
  intro: string;
  // The masked-input prompt ("Linear API token: ").
  tokenPrompt: string;
  // Printed after a successful save ("Run `gnt prebrain --mcp-linear` to
  // read from it.").
  savedHint: string;
  // Test seams -- production omits both and gets real masked input and a
  // real one-read validation.
  readToken?: (commandName: string, prompt: string) => Promise<string>;
  validate?: (token: string) => Promise<void>;
}

// Runs the connect flow and reports whether a token was saved. Prints all
// user-facing messages itself; the caller's command wraps this and exits
// non-zero when it returns false. Nothing is written unless the live
// validation read succeeds.
export async function runConnectFlow<P>(options: RunConnectFlowOptions<P>): Promise<boolean> {
  const { adapter, commandName, intro, tokenPrompt, savedHint } = options;
  const readToken = options.readToken ?? readMaskedToken;
  const validate = options.validate ?? ((token: string) => validateConnection(adapter, token));

  console.log(muted(intro));

  let token: string;
  try {
    token = await readToken(commandName, tokenPrompt);
  } catch (err) {
    console.error(fail(err instanceof Error ? err.message : String(err)));
    return false;
  }
  if (!token) {
    console.error(fail("No token entered."));
    return false;
  }

  return validateAndSaveToken(adapter, token, savedHint, validate);
}

export interface RunOAuthConnectFlowOptions<P> {
  adapter: McpInAdapter<P>;
  // The full command name, for the browser-open failure message ("gnt
  // connect linear-mcp").
  commandName: string;
  // Muted line printed before the browser opens, telling the customer
  // what's about to happen.
  intro: string;
  // The vendor's endpoints/client id/scope/redirect port -- everything
  // runLocalRedirectOAuth needs except the test seams, which this flow
  // injects itself via runOAuth below.
  oauth: Omit<LocalRedirectOAuthConfig, "fetchImpl" | "openImpl">;
  // Printed after a successful save ("Run `gnt prebrain --mcp-linear` to
  // read from it.").
  savedHint: string;
  // Test seams -- production omits both and gets the real browser-redirect
  // flow and a real one-read validation.
  runOAuth?: (config: LocalRedirectOAuthConfig) => Promise<{ accessToken: string }>;
  validate?: (token: string) => Promise<void>;
}

// The OAuth counterpart to runConnectFlow: acquires a credential via the
// browser-redirect flow instead of a pasted token, then runs through the
// exact same validate-before-save contract. Only the access token is ever
// written to disk -- refreshToken/expiresAt are dropped here, same
// ponytail deferral runLocalRedirectOAuth's own doc comment already
// documents (no resolve-time refresh wired in yet). A connector whose
// token turns out to expire in practice during real use is the trigger to
// add that, not before.
export async function runOAuthConnectFlow<P>(options: RunOAuthConnectFlowOptions<P>): Promise<boolean> {
  const { adapter, commandName, intro, savedHint } = options;
  const runOAuth = options.runOAuth ?? runLocalRedirectOAuth;
  const validate = options.validate ?? ((token: string) => validateConnection(adapter, token));
  const oauth: LocalRedirectOAuthConfig = {
    onAuthorizeUrl: (url) => console.log(muted(`If your browser didn't open, visit: ${url}`)),
    ...options.oauth,
  };

  console.log(muted(intro));

  let credential: { accessToken: string };
  try {
    credential = await runOAuth(oauth);
  } catch (err) {
    console.error(fail(`${commandName}: couldn't complete ${adapter.label} authorization: ${err instanceof Error ? err.message : String(err)}`));
    return false;
  }

  return validateAndSaveToken(adapter, credential.accessToken, savedHint, validate);
}

// Sentinel stored in place of a real credential for a "managed OAuth"
// adapter -- one whose server() spawns mcp-remote against a vendor's
// hosted MCP server with NO static Authorization header at all. mcp-remote
// itself then does the whole OAuth login (dynamic client registration
// against the vendor's own auth server, PKCE, its own local callback
// listener) and caches the resulting session in ~/.mcp-auth, entirely
// outside gnt's own credential store -- no gnt-registered app, no bearer
// token gnt ever holds. This value exists only so resolveMcpToken's
// existing "is there something stored" precedence (missing-token errors,
// gnt status's connected/not-connected line) keeps working unchanged for
// these adapters, the same way it already does for a real pasted token.
// It is never sent to anything; an adapter's server() checks for it and
// omits the Authorization header when present.
export const MANAGED_OAUTH_TOKEN = "mcp-remote-managed-oauth";

export interface RunManagedConnectFlowOptions<P> {
  adapter: McpInAdapter<P>;
  // Muted line printed before the connection attempt, telling the
  // customer their browser is about to open for the vendor's own login --
  // there is nothing for them to type or paste, unlike runConnectFlow/
  // runOAuthConnectFlow.
  intro: string;
  // Printed after a successful save ("Run `gnt prebrain --mcp-jira` to
  // read from it.").
  savedHint: string;
  // Test seam -- production omits it and gets a real live probe read,
  // which for a managed adapter is also what triggers mcp-remote's own
  // interactive login as a side effect of connecting.
  validate?: (token: string) => Promise<void>;
}

// The managed-OAuth counterpart to runConnectFlow/runOAuthConnectFlow: no
// credential to collect from the customer at all. The live probe read
// itself is what spawns mcp-remote and (on a first run, or after
// disconnect) drives its own browser OAuth login -- see mcp-remote's own
// progress lines on stderr, already inherited to this terminal
// (mcp-connector.ts never pipes/swallows it). Runs through the same
// validate-before-save contract as the other two flows so a broken
// connection still saves nothing.
export async function runManagedConnectFlow<P>(options: RunManagedConnectFlowOptions<P>): Promise<boolean> {
  const { adapter, intro, savedHint } = options;
  const validate = options.validate ?? ((token: string) => validateConnection(adapter, token));

  console.log(muted(intro));
  return validateAndSaveToken(adapter, MANAGED_OAUTH_TOKEN, savedHint, validate);
}

export interface RunDisconnectFlowOptions<P> {
  adapter: McpInAdapter<P>;
  // The vendor's own revocation call, where one exists. Customer-issued
  // tokens (Notion, monday) have no revoke API, so most adapters omit this
  // and disconnect is purely local. A revoke failure never blocks removing
  // the local token -- same "must always be able to log out locally" bias
  // as credentials.ts's clearCredentials.
  revoke?: (token: string) => Promise<void>;
}

// Disconnects a source: revokes server-side where supported, then removes
// the local token. Reports whether a local token was actually present.
export async function runDisconnectFlow<P>(options: RunDisconnectFlowOptions<P>): Promise<boolean> {
  const { adapter, revoke } = options;
  const token = loadConnectorToken(adapter);

  if (revoke && token) {
    try {
      await revoke(token);
    } catch (err) {
      console.log(
        muted(`Couldn't revoke the ${adapter.label} token server-side (removing it locally anyway): ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  const removed = deleteConnectorToken(adapter);
  if (removed) {
    console.log(ok(`Disconnected ${adapter.label}. The local token has been removed.`));
  } else {
    console.log(muted(`No stored ${adapter.label} token to remove.`));
  }
  return removed;
}

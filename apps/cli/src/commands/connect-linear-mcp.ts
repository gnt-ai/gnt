// `gnt connect linear-mcp`: stores
// a Linear OAuth access token locally for `gnt prebrain --mcp-linear` to
// use. Built on the connector framework's shared runOAuthConnectFlow
// (mcp-framework/connect.ts) -- one browser click via the RFC 8252
// loopback-redirect flow (mcp-framework/oauth.ts) instead of the
// personal-API-key copy/paste this command used to require. Same
// validate-before-save contract runConnectFlow already gave a pasted
// token: nothing is written to ~/.gnt/mcp-tokens.json unless the
// resulting access token proves itself with one real read first.
//
// The access token this flow acquires authenticates the CLI's own local
// mcp-remote bridge process directly to Linear's hosted MCP server (see
// ../prebrain/mcp-linear.ts's own doc comment for why that bridge exists
// and why the trust boundary still holds) exactly the same way a pasted
// personal API key did -- Linear's server accepts either as a static
// `Authorization: Bearer <token>` header, so mcp-linear.ts needed no
// change at all. gnt's own servers are never in this path: the browser
// redirects straight back to a loopback server on this device, and the
// code-for-token exchange is a direct call from this device to
// api.linear.app.
//
// Registered as the "gnt CLI" OAuth application at
// linear.app/settings/api/applications -- publicly available, redirect URI
// http://127.0.0.1:51901/callback (must match exact-string, port included,
// hence LINEAR_OAUTH_PORT below is fixed, not picked fresh here). Client id
// is not a secret (it ships inside the published package either way, same
// tradeoff LocalRedirectOAuthConfig's own doc comment describes for a
// vendor that needs a client secret too) so it's hardcoded directly;
// GNT_LINEAR_OAUTH_CLIENT_ID overrides it for anyone running against their
// own registered app instead. The app's client secret is deliberately never
// used here -- Linear's PKCE flow makes it optional, and embedding a
// "secret" inside a publicly published npm package would not actually be
// one, so this stays pure PKCE.
import { runOAuthConnectFlow } from "../prebrain/mcp-framework/index.js";
import { linearAdapter } from "../prebrain/mcp-linear.js";

const LINEAR_OAUTH_CLIENT_ID = process.env.GNT_LINEAR_OAUTH_CLIENT_ID ?? "d3413e94e84be31cfd921ca33dfd573f";
const LINEAR_OAUTH_PORT = 51901;

export async function connectLinearMcp(): Promise<void> {
  const saved = await runOAuthConnectFlow({
    adapter: linearAdapter,
    commandName: "gnt connect linear-mcp",
    intro: "Opening your browser to authorize gnt with Linear...",
    oauth: {
      authorizationEndpoint: "https://linear.app/oauth/authorize",
      tokenEndpoint: "https://api.linear.app/oauth/token",
      clientId: LINEAR_OAUTH_CLIENT_ID,
      scope: "read",
      port: LINEAR_OAUTH_PORT,
      callbackPath: "/callback",
    },
    savedHint: "Run `gnt prebrain --mcp-linear --linear-teams <id[,id...]>` or `--linear-projects <id[,id...]>` to read from it.",
  });
  if (!saved) process.exit(1);
}

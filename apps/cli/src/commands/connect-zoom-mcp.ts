// `gnt connect zoom-mcp`: stores a Zoom user OAuth
// access token locally for `gnt prebrain --mcp-zoom` to use. Same
// runConnectFlow shape as connect-linear-mcp.ts/connect-sentry-mcp.ts: the
// token is validated with one real read against Zoom's own MCP server (the
// adapter's recordings_list probe) before anything is written to disk. gnt's
// servers are never in this path -- same local-only write as every other
// MCP-in connector's own token.
//
// The intro text below says plainly that the pasted value is a short-lived
// user OAuth access token, not a long-lived API key -- see
// ../prebrain/mcp-zoom.ts's own doc comment for why (Zoom's documented setup
// for a static-token MCP client has no refresh-token path), so a customer
// who sees prebrain start failing weeks later knows to reconnect rather than
// assume something broke.
import { runConnectFlow } from "../prebrain/mcp-framework/index.js";
import { zoomAdapter } from "../prebrain/mcp-zoom.js";

export async function connectZoomMcp(): Promise<void> {
  const saved = await runConnectFlow({
    adapter: zoomAdapter,
    commandName: "gnt connect zoom-mcp",
    intro:
      "Create a Zoom Marketplace \"General App\" (not Server-to-Server OAuth) at marketplace.zoom.us, " +
      "complete its OAuth authorization once to get a user access token, then paste that token below. " +
      "It's short-lived (about an hour) -- you'll need to reconnect with a fresh token periodically, " +
      "this isn't a one-time setup like an API key.",
    tokenPrompt: "Zoom user OAuth access token: ",
    savedHint: "Run `gnt prebrain --mcp-zoom --zoom-hosts <id-or-email[,id-or-email...]>` to read from it.",
  });
  if (!saved) process.exit(1);
}

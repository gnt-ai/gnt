// These are what every real, npm-installed user's CLI actually talks to by
// default -- there's no server-side config to fall back on, so getting
// this wrong means gnt login (and everything else) silently points at
// localhost for anyone who isn't us running a local dev stack. GNT_API_URL/
// GNT_WEB_URL override for local development.
//
export const API_URL = process.env.GNT_API_URL ?? "https://api.gntai.dev";
export const WEB_URL = process.env.GNT_WEB_URL ?? "https://gntai.dev";

// The one published, customer-facing MCP endpoint — everything that prints
// this URL builds it from here instead of concatenating "/mcp" by hand.
// Trailing slash: the real deployed server 307-redirects a bare /mcp to
// /mcp/ (see apps/api/tests/test_mcp_published_url.py's own doc comment) --
// not every MCP client is known to follow a redirect on a POST, so this
// constant is already the final, no-redirect path.
export const MCP_URL = `${API_URL}/mcp/`;

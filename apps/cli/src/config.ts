// gnt is self-hosted; there's no managed deployment to fall back on. By
// default the CLI talks to a local stack on apps/api's own API_ORIGIN/
// WEB_ORIGIN defaults. GNT_API_URL/GNT_WEB_URL point it anywhere else.
export const API_URL = process.env.GNT_API_URL ?? "http://localhost:8000";
export const WEB_URL = process.env.GNT_WEB_URL ?? "http://localhost:3000";

// The one published, customer-facing MCP endpoint — everything that prints
// this URL builds it from here instead of concatenating "/mcp" by hand.
// Trailing slash: the real deployed server 307-redirects a bare /mcp to
// /mcp/ (see apps/api/tests/test_mcp_published_url.py's own doc comment) --
// not every MCP client is known to follow a redirect on a POST, so this
// constant is already the final, no-redirect path.
export const MCP_URL = `${API_URL}/mcp/`;

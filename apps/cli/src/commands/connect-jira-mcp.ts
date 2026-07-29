// `gnt connect jira-mcp`: stores
// a managed-OAuth marker locally for `gnt prebrain --mcp-jira` to use, in
// place of the pasted Jira API token this command used to require. Built
// on the connector framework's shared runManagedConnectFlow
// (mcp-framework/connect.ts) -- there's nothing to type or paste: the live
// probe read this triggers spawns mcp-remote against Atlassian's hosted
// MCP server with no static token, and mcp-remote itself opens the
// customer's browser and runs its own OAuth login (dynamic client
// registration against auth.atlassian.com, confirmed live) before the
// probe can even complete. gnt never registers an app and never holds a
// bearer token for this path -- the session lives in mcp-remote's own
// ~/.mcp-auth cache. See mcp-jira.ts's own doc comment on
// MANAGED_OAUTH_TOKEN/server() for the two-mode credential shape.
//
// This deliberately routes around the admin-gated static-API-token path
// mcp-jira.ts's own doc comment describes ("Admin enablement required",
// "Scoped tokens mandatory") -- Atlassian's Rovo MCP server's own login is
// a different auth surface entirely from the token-creation page an org
// admin can lock down, so an org that blocks self-serve API tokens can
// still connect this way. It does still require the logged-in Atlassian
// account to be a member of a site with Jira (or Confluence) provisioned;
// an account with no such site sees Atlassian's own "Supported sites
// required" wall instead, which is a real account-state blocker this
// command can't route around.
import { runManagedConnectFlow } from "../prebrain/mcp-framework/index.js";
import { jiraAdapter } from "../prebrain/mcp-jira.js";

export async function connectJiraMcp(): Promise<void> {
  const saved = await runManagedConnectFlow({
    adapter: jiraAdapter,
    intro: "Opening your browser to authorize gnt with Atlassian's Rovo MCP server for Jira...",
    savedHint:
      "Run `gnt prebrain --mcp-jira --jira-cloud-id <id-or-site-url> --jira-projects <key[,key...]>` to read from it.",
  });
  if (!saved) process.exit(1);
}

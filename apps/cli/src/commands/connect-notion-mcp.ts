// `gnt connect notion-mcp`: stores a Notion integration
// token locally for `gnt prebrain --mcp-notion` to use. Built on the
// connector framework's shared runConnectFlow (mcp-framework/connect.ts)
// rather than a hand-written saveMcpToken call -- runConnectFlow validates
// the token with one real read against Notion's own MCP server (the
// adapter's `search` probe) before anything is written to disk, so a
// customer never ends up with a saved-but-broken token. Same pattern
// connect-linear-mcp.ts/connect-sentry-mcp.ts/connect-granola-mcp.ts already
// use (this connector predates the framework and originally hand-wrote the
// save; it was later migrated onto runConnectFlow like the
// rest).
//
// This token authenticates gnt's own CLI process directly to Notion's MCP
// server -- gnt's servers are never in that path (see
// ../prebrain/mcp-notion.ts's own doc comment) -- so this command only
// writes the token to this device's own ~/.gnt/mcp-tokens.json.
import { runConnectFlow } from "../prebrain/mcp-framework/index.js";
import { notionAdapter } from "../prebrain/mcp-notion.js";

export async function connectNotionMcp(): Promise<void> {
  const saved = await runConnectFlow({
    adapter: notionAdapter,
    commandName: "gnt connect notion-mcp",
    intro:
      "Create an internal integration at notion.so/my-integrations, share the pages/databases " +
      "you want gnt to read with it, then paste its secret below.",
    tokenPrompt: "Notion integration token: ",
    savedHint: "Run `gnt prebrain --mcp-notion` to read from it.",
  });
  if (!saved) process.exit(1);
}

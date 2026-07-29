// `gnt connect granola-mcp`: stores a Granola MCP
// connection locally for `gnt prebrain --mcp-granola` to use. Shaped like
// connect-notion-mcp.ts/connect-monday-mcp.ts (a local-only write, no gnt
// API involvement -- see connect-notion-mcp.ts's own doc comment for why),
// with one deliberate, flagged difference: Granola's own MCP server
// supports browser OAuth only, not a customer-pasted static token -- see
// ../prebrain/mcp-granola.ts's own "Honest limit" section for the full
// reasoning and why this needs founder review before it ships.
//
// Because readMaskedToken (the framework's shared masked-input prompt)
// has no OAuth-flow variant, this command still asks for a typed value --
// what's typed here is never used as a credential (mcp-remote,
// mcp-granola.ts's own connection bridge, manages the real Granola OAuth
// session on its own, under this device's ~/.mcp-auth). It exists only so
// the framework has a non-empty value to validate with one real read and
// store, matching the connect flow every other adapter uses. The intro
// below says so plainly rather than pretending this is a normal token
// paste.
import { runConnectFlow } from "../prebrain/mcp-framework/index.js";
import { granolaAdapter } from "../prebrain/mcp-granola.js";

export async function connectGranolaMcp(): Promise<void> {
  const saved = await runConnectFlow({
    adapter: granolaAdapter,
    commandName: "gnt connect granola-mcp",
    intro:
      "Granola's MCP server only supports browser sign-in, not a pasted token. Type anything " +
      '(e.g. "ok") and press enter to continue -- a browser window will open for you to sign in ' +
      "to Granola and authorize gnt, then this checks the connection with one read before saving.",
    tokenPrompt: "Press enter to continue: ",
    savedHint: "Run `gnt prebrain --mcp-granola --granola-folders <id[,id...]>` to read from it.",
  });
  if (!saved) process.exit(1);
}

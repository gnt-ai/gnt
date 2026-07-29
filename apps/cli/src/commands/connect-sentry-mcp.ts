// `gnt connect sentry-mcp`: stores a Sentry User
// Auth Token locally for `gnt prebrain --mcp-sentry` to use. Unlike
// connect-notion-mcp.ts/connect-monday-mcp.ts (written before the
// connector framework's connect.ts existed), this one goes through
// runConnectFlow: the token is validated with one real read against
// Sentry's own MCP server (the adapter's find_organizations probe) before
// anything is written to disk, so a customer never ends up with a
// saved-but-broken token. gnt's servers are never in this path -- same
// local-only write as the other two connectors' own tokens.
import { runConnectFlow } from "../prebrain/mcp-framework/index.js";
import { sentryAdapter } from "../prebrain/mcp-sentry.js";

export async function connectSentryMcp(): Promise<void> {
  const saved = await runConnectFlow({
    adapter: sentryAdapter,
    commandName: "gnt connect sentry-mcp",
    intro:
      "Create a Sentry User Auth Token at sentry.io/settings/account/api/auth-tokens/ scoped to just " +
      "org:read and event:read (this connector never needs more), then paste it below.",
    tokenPrompt: "Sentry User Auth Token: ",
    savedHint: "Run `gnt prebrain --mcp-sentry --sentry-org <slug> --sentry-projects <slug[,slug...]>` to read from it.",
  });
  if (!saved) process.exit(1);
}

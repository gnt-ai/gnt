// `gnt disconnect <x>-mcp` for every MCP-in adapter (notion, monday, linear,
// jira, sentry, granola, zoom). Each one is a single call into the
// framework's own runDisconnectFlow (mcp-framework/connect.ts) -- there is
// no per-connector disconnect logic to write, since the framework already
// generalizes "revoke server-side where supported, then remove the local
// token" over any adapter. One shared file rather than seven near-identical
// ones: connect-*.ts is one file per connector because each CONNECT flow's
// intro text/prompts genuinely differ, but every adapter's DISCONNECT flow
// is the same three lines, so splitting this seven ways would just be seven
// copies of the same wrapper.
import { runDisconnectFlow } from "../prebrain/mcp-framework/index.js";
import { granolaAdapter } from "../prebrain/mcp-granola.js";
import { jiraAdapter } from "../prebrain/mcp-jira.js";
import { linearAdapter } from "../prebrain/mcp-linear.js";
import { mondayAdapter } from "../prebrain/mcp-monday.js";
import { notionAdapter } from "../prebrain/mcp-notion.js";
import { sentryAdapter } from "../prebrain/mcp-sentry.js";
import { zoomAdapter } from "../prebrain/mcp-zoom.js";

export async function disconnectNotionMcp(): Promise<void> {
  await runDisconnectFlow({ adapter: notionAdapter });
}

export async function disconnectMondayMcp(): Promise<void> {
  await runDisconnectFlow({ adapter: mondayAdapter });
}

export async function disconnectLinearMcp(): Promise<void> {
  await runDisconnectFlow({ adapter: linearAdapter });
}

export async function disconnectJiraMcp(): Promise<void> {
  await runDisconnectFlow({ adapter: jiraAdapter });
}

export async function disconnectSentryMcp(): Promise<void> {
  await runDisconnectFlow({ adapter: sentryAdapter });
}

export async function disconnectGranolaMcp(): Promise<void> {
  await runDisconnectFlow({ adapter: granolaAdapter });
}

export async function disconnectZoomMcp(): Promise<void> {
  await runDisconnectFlow({ adapter: zoomAdapter });
}

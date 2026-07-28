// The list of every MCP-in adapter the CLI knows about. One place adds a
// new connector to the surfaces that iterate all of them (the `gnt status`
// health lines today; more later) so none of those has to hardcode a
// per-connector branch. A new connector appends its adapter here and shows
// up everywhere generic.
import { granolaAdapter } from "../mcp-granola.js";
import { jiraAdapter } from "../mcp-jira.js";
import { linearAdapter } from "../mcp-linear.js";
import { mondayAdapter } from "../mcp-monday.js";
import { notionAdapter } from "../mcp-notion.js";
import { sentryAdapter } from "../mcp-sentry.js";
import { zoomAdapter } from "../mcp-zoom.js";
import type { AnyMcpInAdapter } from "./types.js";

export const MCP_IN_ADAPTERS: readonly AnyMcpInAdapter[] = [
  notionAdapter,
  mondayAdapter,
  linearAdapter,
  jiraAdapter,
  sentryAdapter,
  granolaAdapter,
  zoomAdapter,
];

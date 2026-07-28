// Connection health for every registered MCP-in connector, for the `gnt
// status` line. An MCP-in token lives only on this device (mcp-tokens.json),
// so "connected" here means "a token is stored locally" -- there is no
// server-side connection record to query the way Slack/GitHub have one, by
// design (gnt's servers never see these tokens). A connector registers by
// being in MCP_IN_ADAPTERS; status.ts renders whatever this returns, so
// adding a connector adds its health line with no status.ts change.
import { loadConnectorToken } from "./credentials.js";
import { MCP_IN_ADAPTERS } from "./registry.js";

export interface McpConnectorHealth {
  // The status label, e.g. "Notion (MCP)".
  label: string;
  // Whether a token for this source is stored on this device.
  connected: boolean;
}

export function mcpConnectorHealth(): McpConnectorHealth[] {
  return MCP_IN_ADAPTERS.map((adapter) => ({
    label: `${adapter.label} (MCP)`,
    connected: loadConnectorToken(adapter) !== undefined,
  }));
}

// The connector framework's public surface. A new MCP-in adapter (Granola,
// Zoom, Linear, Jira, Sentry, Datadog, Figma, HubSpot, ...) imports from
// here and nowhere deeper. See README.md in this directory for the
// step-by-step guide and mcp-notion.ts / mcp-monday.ts for worked
// examples.
export type {
  AnyMcpInAdapter,
  Chunker,
  McpAdapterContext,
  McpInAdapter,
  McpReadDeclaration,
  McpSourceDocument,
  PrebrainChunk,
} from "./types.js";
export { projectToDeclaredFields } from "./fields.js";
export { buildProseDocument } from "./document.js";
export { allowlistOf, resolveMcpToken, runMcpInWalk, validateConnection } from "./walker.js";
export type { McpWalkOptions } from "./walker.js";
export { deleteConnectorToken, loadConnectorToken, saveConnectorToken } from "./credentials.js";
export {
  bootstrapDashboardToken,
  MANAGED_OAUTH_TOKEN,
  readMaskedToken,
  runConnectFlow,
  runDisconnectFlow,
  runManagedConnectFlow,
  runOAuthConnectFlow,
} from "./connect.js";
export type { RunConnectFlowOptions, RunDisconnectFlowOptions, RunManagedConnectFlowOptions, RunOAuthConnectFlowOptions } from "./connect.js";
export {
  parseOAuthCredential,
  refreshOAuthToken,
  runDeviceOAuth,
  runLocalRedirectOAuth,
  serializeOAuthCredential,
} from "./oauth.js";
export type { DeviceOAuthConfig, LocalRedirectOAuthConfig, OAuthCredential } from "./oauth.js";
export { mcpConnectorHealth } from "./health.js";
export type { McpConnectorHealth } from "./health.js";
export { MCP_IN_ADAPTERS } from "./registry.js";

// The low-level MCP client core the framework is built on, re-exported so
// an adapter (and its tests) can name these without reaching past the
// framework. connectStdioMcpServer/callReadOnlyTool are used through the
// runner in normal adapter code; McpToolClient and StdioMcpServerSpec show
// up in adapter signatures.
export { callReadOnlyTool, connectStdioMcpServer, McpConnectorError, tryParseJson } from "../mcp-connector.js";
export type { McpToolClient, McpToolResult, StdioMcpServerSpec } from "../mcp-connector.js";

// Adapter-keyed wrappers over the shared MCP-token storage in
// ../../credentials.ts. Nothing new is stored here -- this is the same
// encrypted-at-0600, local-only, never-sent-to-gnt mcp-tokens.json the two
// original connectors already used -- it just keys every read/write off an
// adapter's own id so a connect/disconnect flow never hand-writes the id
// string and can't drift from the id the walker resolves its token by.
import { deleteMcpToken, loadMcpToken, saveMcpToken } from "../../credentials.js";
import type { AnyMcpInAdapter } from "./types.js";

export function saveConnectorToken(adapter: AnyMcpInAdapter, token: string): void {
  saveMcpToken(adapter.id, token);
}

export function loadConnectorToken(adapter: AnyMcpInAdapter): string | undefined {
  return loadMcpToken(adapter.id);
}

// The local half of disconnect: drops this adapter's stored token and
// reports whether one was there. The vendor-side revoke, where the vendor
// supports one, is the adapter's own step in the disconnect flow
// (connect.ts) -- customer-issued tokens like Notion's and monday's have
// no revoke API, so for those this is the whole of disconnect.
export function deleteConnectorToken(adapter: AnyMcpInAdapter): boolean {
  return deleteMcpToken(adapter.id);
}

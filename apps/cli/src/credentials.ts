import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// GNT_CONFIG_DIR override exists for tests (see test/logout.test.ts) --
// there's no real-world reason to point a normal `gnt` install anywhere
// but the default, this just avoids sandboxing tests against a real
// user's actual ~/.gnt/credentials.json.
//
// Read fresh on every call, not frozen into a module-level const at
// import time: bun test runs every test/*.test.ts file in one shared
// process with one shared module cache, so a top-level `const CONFIG_DIR =
// process.env.GNT_CONFIG_DIR ?? ...` would only ever see whichever test
// file's own GNT_CONFIG_DIR happened to be set the first time anything
// imported this module -- every other test file's own temp dir override
// would silently never take effect. Real `gnt` usage never mutates
// GNT_CONFIG_DIR mid-process, so this has no behavioral cost outside tests.
function configDir(): string {
  return process.env.GNT_CONFIG_DIR ?? join(homedir(), ".gnt");
}

function credentialsPath(): string {
  return join(configDir(), "credentials.json");
}

function mcpTokensPath(): string {
  return join(configDir(), "mcp-tokens.json");
}

// writeFileSync's `mode` option only applies when the file is actually
// created (O_CREAT) -- it's silently ignored on an existing file, so a
// credentials file left over from before 0600 was enforced (or created
// under a looser umask) would stay world-readable across every later
// `gnt login`/`gnt connect` rewrite. chmodSync after every write closes
// that regardless of the file's prior state.
function writeSecretFile(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

// The customer's own auth token for a live MCP-in source (e.g.
// `gnt connect notion-mcp`) -- a fundamentally different secret
// from api_key/credentials.json above: that file's contents authenticate
// this CLI to gnt's own API, this one authenticates this CLI directly to
// a third party (Notion, monday.com) and gnt's servers never see it. Kept
// in a separate file rather than a new field on credentials.json so the
// two trust boundaries stay visibly separate on disk, not just in code.
//
// A plain string rather than a closed union: the connector framework
// (prebrain/mcp-framework) is what actually decides which ids are real --
// each adapter declares its own id there, so adding the next MCP-in
// connector is one new adapter file, not an edit to this foundational
// module. Storage stays shape-compatible: the on-disk mcp-tokens.json is
// still `{ "<id>": "<token>" }`, only the id set is open now.
export type McpServerId = string;

function readMcpTokens(): Record<string, string> {
  if (!existsSync(mcpTokensPath())) return {};
  try {
    const data = JSON.parse(readFileSync(mcpTokensPath(), "utf-8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export function saveMcpToken(server: McpServerId, token: string): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const tokens = readMcpTokens();
  tokens[server] = token;
  writeSecretFile(mcpTokensPath(), JSON.stringify(tokens, null, 2));
}

// Non-throwing -- an MCP-in walker only runs when explicitly opted into
// (see commands/prebrain.ts's --mcp-notion/--mcp-monday flags), and a
// missing token there is "tell the customer to run `gnt connect
// notion-mcp` or pass --notion-mcp-token" territory, not a process-exit
// like loadApiKey's login requirement.
export function loadMcpToken(server: McpServerId): string | undefined {
  const tokens = readMcpTokens();
  return typeof tokens[server] === "string" ? tokens[server] : undefined;
}

// Removes one source's stored token -- the local half of `gnt disconnect
// <source>-mcp` (the connector framework pairs this with the vendor's own
// revocation call where one exists). Returns whether a token was actually
// present, so the caller can tell "disconnected" from "nothing to do".
// Rewrites the file with the remaining tokens rather than deleting it, so
// one source's disconnect never drops another source's still-valid token.
export function deleteMcpToken(server: McpServerId): boolean {
  const tokens = readMcpTokens();
  if (typeof tokens[server] !== "string") return false;
  delete tokens[server];
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeSecretFile(mcpTokensPath(), JSON.stringify(tokens, null, 2));
  return true;
}

// keyId is the mcp_api_keys row id handed back by POST /v1/settings/cli-key
// at mint time -- saved so `gnt logout` can revoke this exact key
// server-side later without needing a live session (see logout.ts). Optional
// because it's threaded through login's browser callback, not guaranteed on
// every response shape forever.
export function saveApiKey(key: string, keyId?: string | null): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeSecretFile(credentialsPath(), JSON.stringify({ api_key: key, key_id: keyId ?? null }, null, 2));
}

// Clears the local file regardless of whether server-side revocation (see
// logout.ts) succeeded -- `gnt logout` must never leave someone unable to
// log out just because the network or the API is down.
export function clearCredentials(): boolean {
  if (!existsSync(credentialsPath())) return false;
  rmSync(credentialsPath());
  return true;
}

export function loadApiKey(): string {
  if (!existsSync(credentialsPath())) {
    console.error("Not logged in. Run `gnt login` first.");
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(credentialsPath(), "utf-8"));
  if (!data.api_key) {
    console.error("Credentials file is missing an API key. Run `gnt login` again.");
    process.exit(1);
  }
  return data.api_key;
}

// Non-throwing, non-exiting counterpart to loadApiKey -- `gnt logout` needs
// to attempt a server-side revoke before clearing the file, but must never
// fail to log out locally just because credentials are missing, malformed,
// or from before key_id was saved (pre-existing sessions logged in before
// server-side revocation shipped won't have one).
export function tryLoadCredentials(): { apiKey: string; keyId: string | null } | null {
  if (!existsSync(credentialsPath())) return null;
  try {
    const data = JSON.parse(readFileSync(credentialsPath(), "utf-8"));
    if (typeof data.api_key !== "string") return null;
    return { apiKey: data.api_key, keyId: typeof data.key_id === "string" ? data.key_id : null };
  } catch {
    return null;
  }
}

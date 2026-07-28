import { API_URL, MCP_URL } from "../config.js";
import { loadApiKey } from "../credentials.js";
import { bold, dim, error, fail, muted, ok, text } from "../theme.js";

interface McpKey {
  id: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
}

async function authedFetch(key: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...init?.headers },
  });
}

export async function listKeys(): Promise<void> {
  const key = loadApiKey();
  const res = await authedFetch(key, "/v1/settings/mcp-keys");
  if (!res.ok) {
    console.error(fail(`Failed to list keys (${res.status}).`));
    process.exit(1);
  }
  const keys: McpKey[] = await res.json();
  if (keys.length === 0) {
    console.log(muted("No MCP keys yet. Create one with `gnt keys create`."));
    return;
  }
  const idWidth = Math.max(...keys.map((k) => k.id.length));
  const nameWidth = Math.max(...keys.map((k) => (k.name ?? "(unnamed)").length));
  for (const k of keys) {
    const status = k.revoked_at
      ? error("revoked")
      : k.last_used_at
        ? muted(`last used ${k.last_used_at}`)
        : dim("unused");
    console.log(
      `${dim(k.id.padEnd(idWidth))}  ${text((k.name ?? "(unnamed)").padEnd(nameWidth))}  ${status}`,
    );
  }
}

export async function createKey(name?: string): Promise<void> {
  const key = loadApiKey();
  const res = await authedFetch(key, "/v1/settings/mcp-keys", {
    method: "POST",
    body: JSON.stringify({ name: name ?? null }),
  });
  if (!res.ok) {
    console.error(fail(`Failed to create key (${res.status}).`));
    process.exit(1);
  }
  const data = await res.json();
  console.log(`${muted("MCP URL:")} ${text(MCP_URL)}`);
  console.log(`${muted("Key:")}     ${bold(data.key)}`);
  console.log(dim("This is shown once — copy it now. Give it to the agent that will call the MCP endpoint."));
}

export async function revokeKey(id: string): Promise<void> {
  const key = loadApiKey();
  const res = await authedFetch(key, `/v1/settings/mcp-keys/${id}/revoke`, { method: "POST" });
  if (!res.ok) {
    console.error(fail(`Failed to revoke key (${res.status}).`));
    process.exit(1);
  }
  console.log(ok(`Revoked ${id}`));
}

export async function rotateKey(id: string): Promise<void> {
  const key = loadApiKey();
  const res = await authedFetch(key, `/v1/settings/mcp-keys/${id}/rotate`, { method: "POST" });
  if (!res.ok) {
    console.error(fail(`Failed to rotate key (${res.status}).`));
    process.exit(1);
  }
  const data = await res.json();
  console.log(`${muted("MCP URL:")} ${text(MCP_URL)}`);
  console.log(`${muted("Key:")}     ${bold(data.key)}`);
  console.log(
    dim(
      `This is shown once — copy it now. ${id} is now revoked; give this new key to the agent instead.`,
    ),
  );
}

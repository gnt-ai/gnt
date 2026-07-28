import { API_URL } from "../config.js";
import { loadApiKey } from "../credentials.js";
import { bold, dim, error, fail, muted, ok, text } from "../theme.js";

interface WebhookTokenSummary {
  id: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

async function authedFetch(key: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...init?.headers },
  });
}

export async function listWebhookTokens(): Promise<void> {
  const key = loadApiKey();
  const res = await authedFetch(key, "/v1/settings/webhook-tokens");
  if (!res.ok) {
    console.error(fail(`Failed to list webhook tokens (${res.status}).`));
    process.exit(1);
  }
  const tokens: WebhookTokenSummary[] = await res.json();
  if (tokens.length === 0) {
    console.log(muted("No webhook tokens yet. Create one with `gnt webhook create`."));
    return;
  }
  const idWidth = Math.max(...tokens.map((t) => t.id.length));
  const nameWidth = Math.max(...tokens.map((t) => (t.name ?? "(unnamed)").length));
  for (const t of tokens) {
    const status = t.revoked_at
      ? error("revoked")
      : t.last_used_at
        ? muted(`last used ${t.last_used_at}`)
        : dim("unused");
    console.log(
      `${dim(t.id.padEnd(idWidth))}  ${text((t.name ?? "(unnamed)").padEnd(nameWidth))}  ${status}`,
    );
  }
}

export async function createWebhookToken(name?: string): Promise<void> {
  const key = loadApiKey();
  const res = await authedFetch(key, "/v1/settings/webhook-tokens", {
    method: "POST",
    body: JSON.stringify({ name: name ?? null }),
  });
  if (!res.ok) {
    console.error(fail(`Failed to create webhook token (${res.status}).`));
    process.exit(1);
  }
  const data = await res.json();
  console.log(`${muted("Ingest URL:")} ${bold(data.ingest_url)}`);
  console.log(
    dim(
      "This is shown once. Copy it now. Paste it into your tool's outbound webhook settings as " +
        "the URL it POSTs to. Any tool or system that can send an HTTP POST can feed gnt. See the docs for a monday.com/HubSpot recipe.",
    ),
  );
}

export async function revokeWebhookToken(id: string): Promise<void> {
  const key = loadApiKey();
  const res = await authedFetch(key, `/v1/settings/webhook-tokens/${id}/revoke`, { method: "POST" });
  if (!res.ok) {
    console.error(fail(`Failed to revoke webhook token (${res.status}).`));
    process.exit(1);
  }
  console.log(ok(`Revoked ${id}`));
}

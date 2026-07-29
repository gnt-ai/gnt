// `gnt connect openclaw`: the mirror image of
// connect-notion-mcp.ts/connect-monday-mcp.ts. Those point this CLI AT a
// third party's MCP server to read from it; this one points a third
// party's agent harness (OpenClaw) AT gnt's own MCP endpoint so it can
// call check_action before it acts. Shaped like connect-github.ts's and
// connect-figma.ts's own hand-written interactive commands rather than
// mcp-framework's runConnectFlow, which is typed around gnt calling OUT to
// a vendor's server -- this command never calls a vendor MCP server, it
// edits a JSON config file on disk and, if the customer wants one, mints a
// gnt MCP key through gnt's own API.
//
// Config shape verified live against docs.openclaw.ai (2026-07-18, see the
// PR description for the exact pages): OpenClaw resolves its config at
// ~/.openclaw/openclaw.json, and a remote MCP server goes under the
// top-level "mcp"."servers" key with url/transport/headers fields
// (docs.openclaw.ai/gateway/configuration-reference,
// docs.openclaw.ai/gateway/config-tools). Those same docs warn against
// inlining secrets in openclaw.json ("don't put secrets inline ... use
// system env vars and reference them in the config with
// ${VARIABLE_NAME}") -- this command follows that guidance itself: the
// config it writes always references ${GNT_MCP_KEY}, never the plaintext
// key, whether or not a key was minted in the same run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { API_URL, MCP_URL } from "../config.js";
import { tryLoadCredentials } from "../credentials.js";
import { bold, dim, fail, muted, ok, text } from "../theme.js";

const OPENCLAW_CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");
const GNT_SERVER_ID = "gnt-brain";
const GNT_KEY_ENV_VAR = "GNT_MCP_KEY";

// MCP_URL (config.ts) is already the canonical, no-redirect form -- no
// per-caller trailing-slash workaround needed here anymore.
const GNT_MCP_ENDPOINT = MCP_URL;

function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function confirm(prompt: string): Promise<boolean> {
  const answer = await readLine(muted(`${prompt} [y/N] `));
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

function serverBlock(): Record<string, unknown> {
  return {
    url: GNT_MCP_ENDPOINT,
    transport: "streamable-http",
    headers: { Authorization: `Bearer \${${GNT_KEY_ENV_VAR}}` },
  };
}

function printManualBlock(): void {
  const block = { mcp: { servers: { [GNT_SERVER_ID]: serverBlock() } } };
  console.log(muted('Add this under the top-level "mcp"."servers" key in ~/.openclaw/openclaw.json:'));
  console.log(text(JSON.stringify(block, null, 2)));
  console.log(
    dim(
      `Then export ${GNT_KEY_ENV_VAR}=<your gnt MCP key> before starting OpenClaw's gateway (run \`gnt keys create\` to mint one).`,
    ),
  );
}

// Offers to mint a fresh MCP key through gnt's own API, using this
// device's existing `gnt login` session -- the same POST this CLI's own
// `gnt keys create` calls (see commands/keys.ts's createKey). Returns null
// (never throws) on anything short of a successful mint: no local login,
// declined, unreachable, or a non-2xx response all fall back to letting
// the caller ask for an existing key instead.
async function mintKey(): Promise<string | null> {
  const creds = tryLoadCredentials();
  if (!creds) return null;
  const wants = await confirm("Mint a fresh gnt MCP key for OpenClaw now?");
  if (!wants) return null;

  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1/settings/mcp-keys`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openclaw" }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.log(
      muted(`Couldn't reach ${API_URL} to mint a key (${err instanceof Error ? err.message : String(err)}) -- continuing without one.`),
    );
    return null;
  }
  if (!res.ok) {
    console.log(muted(`Couldn't mint an MCP key (${res.status}) -- continuing without one.`));
    return null;
  }
  const data = await res.json();
  if (typeof data.key !== "string") return null;
  console.log(ok(`Minted an MCP key: ${bold(data.key)}`));
  console.log(dim("This is shown once -- copy it now."));
  return data.key;
}

// One real read against gnt's live MCP endpoint before anything is written
// to OpenClaw's config -- the same "validate before save" bias every other
// connect flow in this CLI already has (see mcp-framework/connect.ts's own
// doc comment), applied to the reversed direction this command wires up.
async function validateKeyLive(key: string): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(GNT_MCP_ENDPOINT), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: "gnt-connect-openclaw", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    await client.listTools();
  } finally {
    await client.close().catch(() => {});
  }
}

export async function connectOpenclaw(): Promise<void> {
  if (!existsSync(OPENCLAW_CONFIG_PATH)) {
    console.log(muted(`No local OpenClaw install detected (${OPENCLAW_CONFIG_PATH} doesn't exist).`));
    printManualBlock();
    return;
  }

  const raw = readFileSync(OPENCLAW_CONFIG_PATH, "utf-8");
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw);
  } catch {
    console.log(
      muted(
        `${OPENCLAW_CONFIG_PATH} isn't strict JSON (OpenClaw allows comments and trailing commas there) -- this command won't risk corrupting it by auto-patching. Add the block by hand instead:`,
      ),
    );
    printManualBlock();
    return;
  }

  const mcp = (config.mcp ?? {}) as Record<string, unknown>;
  const servers = (mcp.servers ?? {}) as Record<string, unknown>;
  if (servers[GNT_SERVER_ID]) {
    console.log(
      ok(`OpenClaw is already configured to connect to gnt ("${GNT_SERVER_ID}" already exists under mcp.servers in ${OPENCLAW_CONFIG_PATH}).`),
    );
    return;
  }

  console.log(ok(`Found an OpenClaw install at ${OPENCLAW_CONFIG_PATH}.`));

  let key = await mintKey();
  if (!key && (await confirm("Do you already have a gnt MCP key to use instead?"))) {
    key = await readLine(muted("gnt MCP key: "));
  }

  if (key) {
    console.log(muted("Checking the connection with one live call before writing anything..."));
    try {
      await validateKeyLive(key);
      console.log(ok("Connected to gnt's MCP endpoint."));
    } catch (err) {
      console.error(fail(`Couldn't reach gnt's MCP endpoint with that key: ${err instanceof Error ? err.message : String(err)}`));
      console.log(muted("Nothing written. Fix the key and re-run `gnt connect openclaw`, or add the block by hand:"));
      printManualBlock();
      return;
    }
  }

  const block = serverBlock();
  console.log(muted(`This will add the following under "mcp"."servers" in ${OPENCLAW_CONFIG_PATH}:`));
  console.log(text(JSON.stringify({ [GNT_SERVER_ID]: block }, null, 2)));

  if (!(await confirm(`Write this to ${OPENCLAW_CONFIG_PATH}?`))) {
    console.log(muted("Nothing written."));
    return;
  }

  config.mcp = { ...mcp, servers: { ...servers, [GNT_SERVER_ID]: block } };
  writeFileSync(OPENCLAW_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);

  console.log(ok(`Added "${GNT_SERVER_ID}" to ${OPENCLAW_CONFIG_PATH}.`));
  console.log(
    dim(
      key
        ? `Export ${GNT_KEY_ENV_VAR}=<the key printed above> in your shell before starting OpenClaw's gateway, then restart it.`
        : `Run \`gnt keys create\` to mint a key, export ${GNT_KEY_ENV_VAR}=<that key> in your shell before starting OpenClaw's gateway, then restart it.`,
    ),
  );
}

// `gnt connect hermes`: points a local Hermes
// Agent install (github.com/NousResearch/hermes-agent) at gnt's published
// MCP endpoint, so Hermes can call check_action, search_rules, get_rule,
// list_skill_packs, and get_skill_pack the same way any other MCP client
// does. This is the reverse direction from connect-figma.ts and the
// *-mcp.ts connectors -- those read INTO gnt from a third-party MCP
// server; this one makes gnt itself the MCP server a third-party agent
// harness reads FROM, so it edits Hermes's own config file instead of
// gnt's local vault.
//
// Detection: Hermes's data directory is ~/.hermes (per its own install
// docs -- "Data directory: ~/.hermes/"), created by its install script
// regardless of which install method was used. Its absence means no
// local Hermes install to connect, so this exits without touching
// anything rather than creating a config for an app that isn't there.
//
// Consent: nothing is written until the customer explicitly agrees to
// the exact block shown on screen (never silent), matching the pattern
// connect-figma.ts and connect-github.ts already use for local secrets --
// this one asks before writing to disk at all, since unlike those two it
// edits a file this command doesn't own.
//
// Secret handling: config.yaml never holds the real key, only the literal
// ${GNT_MCP_KEY} reference -- see hermes-config.ts's own doc comment for
// why Hermes resolving that from the environment is safe to rely on, and
// connect-openclaw.ts for the identical choice on the OpenClaw side.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { API_URL } from "../config.js";
import { loadApiKey } from "../credentials.js";
import { GNT_KEY_ENV_VAR, HERMES_CONFIG_PATH, HERMES_DIR, planAddGntServer } from "../hermes-config.js";
import { bold, dim, fail, muted, ok, text } from "../theme.js";

function readYesNo(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// Mints a fresh gnt MCP key through gnt's own API -- the same POST
// commands/keys.ts's createKey makes. Non-throwing: a failed mint here
// shouldn't undo a config write that already succeeded, so the caller
// prints a fallback ("run `gnt keys create` yourself") instead of exiting.
async function mintKey(gntKey: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1/settings/mcp-keys`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gntKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "hermes" }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.log(muted(`Couldn't reach ${API_URL} to mint a key (${err instanceof Error ? err.message : String(err)}).`));
    return null;
  }
  if (!res.ok) {
    console.log(muted(`Couldn't mint an MCP key (${res.status}).`));
    return null;
  }
  const data = (await res.json()) as { key?: string };
  return typeof data.key === "string" ? data.key : null;
}

function printExportHint(key: string | null): void {
  console.log(
    dim(
      key
        ? `Export ${GNT_KEY_ENV_VAR}=${key} in your shell before starting Hermes (or add "${GNT_KEY_ENV_VAR}=${key}" to ~/.hermes/.env, Hermes's own place for secrets), then restart \`hermes chat\` or run /reload-mcp.`
        : `Run \`gnt keys create\` to mint a key, then export ${GNT_KEY_ENV_VAR}=<that key> in your shell (or add it to ~/.hermes/.env) before starting Hermes.`,
    ),
  );
}

export async function connectHermes(): Promise<void> {
  const gntKey = loadApiKey();

  if (!existsSync(HERMES_DIR)) {
    console.error(
      fail(
        `No local Hermes install found at ${HERMES_DIR}. Install it first ` +
          `(https://hermes-agent.nousresearch.com/docs/getting-started/installation), ` +
          `then run \`gnt connect hermes\` again.`,
      ),
    );
    process.exit(1);
  }

  const existingConfig = existsSync(HERMES_CONFIG_PATH) ? readFileSync(HERMES_CONFIG_PATH, "utf-8") : "";
  const plan = planAddGntServer(existingConfig);

  if (plan.status === "already-connected") {
    console.log(ok(`Hermes is already configured to talk to gnt (found an "mcp_servers.gnt" entry in ${HERMES_CONFIG_PATH}).`));
    console.log(dim(`Edit that entry directly, or remove it and rerun \`gnt connect hermes\` for a fresh ${GNT_KEY_ENV_VAR}.`));
    return;
  }

  console.log(muted(`Found a local Hermes install at ${HERMES_DIR}.`));
  console.log(muted(`This adds a "gnt" MCP server entry to ${HERMES_CONFIG_PATH} so Hermes can reach gnt's MCP endpoint.`));
  console.log();
  console.log(text("The following will be added:"));
  for (const line of plan.preview) console.log(dim(line));
  console.log();

  let consented: boolean;
  try {
    if (!process.stdin.isTTY) throw new Error("gnt connect hermes needs an interactive terminal.");
    consented = await readYesNo(muted(`Write this to ${HERMES_CONFIG_PATH}? (y/N) `));
  } catch (err) {
    console.error(fail(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  if (!consented) {
    console.log(muted("Nothing written. Run `gnt keys create` and add the block above by hand if you change your mind."));
    return;
  }

  mkdirSync(HERMES_DIR, { recursive: true });
  if (existingConfig) {
    writeFileSync(`${HERMES_CONFIG_PATH}.bak`, existingConfig, { mode: 0o600 });
  }
  writeFileSync(HERMES_CONFIG_PATH, plan.apply(), { mode: 0o600 });

  console.log(ok("Connected. gnt's MCP tools are now available to Hermes."));
  if (existingConfig) console.log(dim(`A backup of the previous config was saved to ${HERMES_CONFIG_PATH}.bak.`));

  const mintedKey = await mintKey(gntKey);
  if (mintedKey) {
    console.log(`${muted("MCP key:")} ${bold(mintedKey)}`);
    console.log(dim("This is shown once -- copy it now."));
  }
  printExportHint(mintedKey);
  console.log(
    dim(
      "Install the gnt skill too (see the Hermes docs tab at gntai.dev/docs) so Hermes actually calls check_action before acting, not just has it available.",
    ),
  );
}

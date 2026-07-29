// `gnt connect hubspot`: stores a HubSpot private
// app access token locally for `gnt prebrain --hubspot-notes` to use. Not
// an MCP-in connector -- see ../prebrain/hubspot-notes.ts's own doc
// comment for why -- so this doesn't go through mcp-framework's
// runConnectFlow, same shape as connect-figma.ts's/connect-datadog.ts's
// own hand-written interactive commands: gnt's own backend is never in
// this token's path, only this device's own ~/.gnt/mcp-tokens.json.
import { emitKeypressEvents, type Key } from "node:readline";
import { deleteMcpToken, saveMcpToken } from "../credentials.js";
import { HUBSPOT_TOKEN_ID, validateHubspotToken } from "../prebrain/hubspot-notes.js";
import { dim, fail, muted, ok } from "../theme.js";

// Identical shape to connect-figma.ts's own readMaskedLine -- copied
// rather than shared, same reasoning that file gives for its own copy.
function readMaskedLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("gnt connect hubspot needs an interactive terminal."));
      return;
    }

    let buffer = "";
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    const onKeypress = (str: string, keyInfo: Key) => {
      if (keyInfo.ctrl && keyInfo.name === "c") {
        cleanup();
        console.log();
        reject(new Error("aborted"));
        return;
      }
      if (keyInfo.name === "return" || keyInfo.name === "enter") {
        cleanup();
        console.log();
        resolve(buffer);
        return;
      }
      if (keyInfo.name === "backspace") {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      if (str && !keyInfo.ctrl) {
        buffer += str;
        process.stdout.write("*");
      }
    };

    process.stdin.on("keypress", onKeypress);
  });
}

export async function connectHubspot(): Promise<void> {
  console.log(
    muted(
      "Create a private app at Settings -> Integrations -> Private Apps, grant it read scope for CRM " +
        "objects and engagements, copy the generated access token, then paste it below. This connector " +
        "only ever reads note text -- see `gnt prebrain --help` for the pipeline/team scoping flags.",
    ),
  );

  let token: string;
  try {
    token = await readMaskedLine(muted("HubSpot private app access token: "));
  } catch (err) {
    console.error(fail(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  if (!token) {
    console.error(fail("No token entered."));
    process.exit(1);
  }

  console.log(muted("Checking the HubSpot connection with one read before saving..."));
  try {
    await validateHubspotToken(token);
  } catch (err) {
    console.error(
      fail(`Couldn't reach HubSpot with that token, nothing saved: ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exit(1);
  }

  saveMcpToken(HUBSPOT_TOKEN_ID, token);
  console.log(
    ok(
      "Saved. Run `gnt prebrain --hubspot-notes --hubspot-pipelines <id[,id...]>` and/or " +
        "`--hubspot-teams <id[,id...]>` to read from it.",
    ),
  );
  console.log(dim("This token is stored only on this device (~/.gnt/mcp-tokens.json) -- gnt's servers never see it."));
}

// `gnt disconnect hubspot`. Purely local, same as every disconnect in this
// CLI's mcp-tokens.json world: a private app access token is customer-
// issued, with no revoke API for gnt to call, so removing the local copy is
// the whole of disconnect here.
export async function disconnectHubspot(): Promise<void> {
  const removed = deleteMcpToken(HUBSPOT_TOKEN_ID);
  if (removed) {
    console.log(ok("Disconnected HubSpot. The local access token has been removed."));
  } else {
    console.log(muted("No stored HubSpot connection to remove."));
  }
}

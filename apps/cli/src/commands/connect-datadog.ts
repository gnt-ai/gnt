// `gnt connect datadog`: stores a Datadog API key +
// application key pair, and an optional site, locally for `gnt prebrain
// --datadog-notebooks` to use. Not an MCP-in connector -- see
// ../prebrain/datadog-notebooks.ts's own doc comment for why -- so this
// doesn't go through mcp-framework's runConnectFlow, which is typed around
// the MCP adapter shape and a single-token credential. Shaped like
// connect-figma.ts's own hand-written interactive command: its own masked-
// input reader, gnt's own backend never in either credential's path,
// written only to this device's local ~/.gnt/mcp-tokens.json.
import { emitKeypressEvents, type Key } from "node:readline";
import { deleteMcpToken, saveMcpToken } from "../credentials.js";
import {
  DATADOG_TOKEN_ID,
  DEFAULT_DATADOG_SITE,
  resolveDatadogCredentials,
  serializeDatadogCredentials,
  validateDatadogCredentials,
} from "../prebrain/datadog-notebooks.js";
import { dim, fail, muted, ok } from "../theme.js";

// Identical shape to connect-figma.ts's own readMaskedLine -- copied
// rather than shared, same reasoning that file gives for its own copy.
function readMaskedLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("gnt connect datadog needs an interactive terminal."));
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

// A plain, unmasked prompt for the one non-secret value this connector asks
// for (the Datadog site) -- same keypress-based reader as readMaskedLine
// above, just echoing what's typed instead of masking it, so this file has
// no separate readline.Interface dependency.
function readPlainLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("gnt connect datadog needs an interactive terminal."));
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
        process.stdout.write(str);
      }
    };

    process.stdin.on("keypress", onKeypress);
  });
}

export async function connectDatadog(): Promise<void> {
  console.log(
    muted(
      "Create an API key at organization settings -> API Keys, and an application key at organization " +
        "settings -> Application Keys (scope it to just notebooks_read if your account supports scoped " +
        "application keys), then paste both below.",
    ),
  );

  let apiKey: string;
  let appKey: string;
  let siteInput: string;
  try {
    apiKey = await readMaskedLine(muted("Datadog API key: "));
    appKey = await readMaskedLine(muted("Datadog application key: "));
    siteInput = await readPlainLine(muted(`Datadog site [${DEFAULT_DATADOG_SITE}]: `));
  } catch (err) {
    console.error(fail(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  if (!apiKey || !appKey) {
    console.error(fail("Both an API key and an application key are required."));
    process.exit(1);
  }

  const creds = resolveDatadogCredentials({ apiKey, appKey, site: siteInput || undefined });

  console.log(muted("Checking the Datadog connection with one read before saving..."));
  try {
    await validateDatadogCredentials(creds);
  } catch (err) {
    console.error(
      fail(`Couldn't reach Datadog with those credentials, nothing saved: ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exit(1);
  }

  saveMcpToken(DATADOG_TOKEN_ID, serializeDatadogCredentials(creds));
  console.log(ok("Saved. Run `gnt prebrain --datadog-notebooks --datadog-notebook-ids <id[,id...]>` to read from it."));
  console.log(dim("These credentials are stored only on this device (~/.gnt/mcp-tokens.json) -- gnt's servers never see them."));
}

// `gnt disconnect datadog`. Purely local, same as every disconnect in this
// CLI's mcp-tokens.json world: the API key + application key pair is
// customer-issued, with no revoke API for gnt to call, so removing the
// local copy is the whole of disconnect here.
export async function disconnectDatadog(): Promise<void> {
  const removed = deleteMcpToken(DATADOG_TOKEN_ID);
  if (removed) {
    console.log(ok("Disconnected Datadog. The local API key, application key, and site have been removed."));
  } else {
    console.log(muted("No stored Datadog connection to remove."));
  }
}

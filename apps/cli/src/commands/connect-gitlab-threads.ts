// `gnt connect gitlab-threads`: stores a GitLab
// personal or project access token, and an optional instance base URL,
// locally for `gnt prebrain --gitlab-threads` to use. Not an MCP-in
// connector -- see ../prebrain/gitlab-threads.ts's own doc comment for why
// -- so this doesn't go through mcp-framework's runConnectFlow, which is
// typed around the MCP adapter shape and a single-token credential. Shaped
// like connect-datadog.ts's own hand-written interactive command: its own
// masked-input reader for the secret, a plain reader for the one non-secret
// value (here, the instance URL rather than a site region), gnt's own
// backend never in either value's path, written only to this device's
// local ~/.gnt/mcp-tokens.json.
import { emitKeypressEvents, type Key } from "node:readline";
import { deleteMcpToken, saveMcpToken } from "../credentials.js";
import {
  DEFAULT_GITLAB_URL,
  GITLAB_TOKEN_ID,
  resolveGitlabCredentials,
  serializeGitlabCredentials,
  validateGitlabToken,
} from "../prebrain/gitlab-threads.js";
import { dim, fail, muted, ok } from "../theme.js";

// Identical shape to connect-figma.ts's/connect-datadog.ts's own
// readMaskedLine -- copied rather than shared, same reasoning those files
// give for their own copy.
function readMaskedLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("gnt connect gitlab-threads needs an interactive terminal."));
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
// for (the GitLab instance URL) -- same keypress-based reader as
// readMaskedLine above, just echoing what's typed instead of masking it,
// identical to connect-datadog.ts's own readPlainLine.
function readPlainLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("gnt connect gitlab-threads needs an interactive terminal."));
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

export async function connectGitlabThreads(): Promise<void> {
  console.log(
    muted(
      "Create a personal access token (user settings -> Access tokens) or a project access token " +
        "(project settings -> Access tokens) scoped to read_api, then paste it below. Self-managed GitLab? " +
        "Enter your instance's own URL when asked.",
    ),
  );

  let token: string;
  let baseUrlInput: string;
  try {
    token = await readMaskedLine(muted("GitLab access token: "));
    baseUrlInput = await readPlainLine(muted(`GitLab instance URL [${DEFAULT_GITLAB_URL}]: `));
  } catch (err) {
    console.error(fail(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  if (!token) {
    console.error(fail("No token entered."));
    process.exit(1);
  }

  const creds = resolveGitlabCredentials({ token, baseUrl: baseUrlInput || undefined });

  console.log(muted("Checking the GitLab connection with one read before saving..."));
  try {
    await validateGitlabToken(creds);
  } catch (err) {
    console.error(
      fail(
        `Couldn't reach GitLab with that token, nothing saved: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    process.exit(1);
  }

  saveMcpToken(GITLAB_TOKEN_ID, serializeGitlabCredentials(creds));
  console.log(ok("Saved. Run `gnt prebrain --gitlab-threads --gitlab-projects <id-or-path[,id-or-path...]>` to read from it."));
  console.log(dim("This token is stored only on this device (~/.gnt/mcp-tokens.json) -- gnt's servers never see it."));
}

// `gnt disconnect gitlab-threads`. Purely local, same as every disconnect in
// this CLI's mcp-tokens.json world: a personal/project access token is
// customer-issued, with no revoke API for gnt to call, so removing the
// local copy is the whole of disconnect here.
export async function disconnectGitlabThreads(): Promise<void> {
  const removed = deleteMcpToken(GITLAB_TOKEN_ID);
  if (removed) {
    console.log(ok("Disconnected GitLab. The local access token and instance URL have been removed."));
  } else {
    console.log(muted("No stored GitLab connection to remove."));
  }
}

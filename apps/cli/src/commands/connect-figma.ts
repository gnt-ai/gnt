// `gnt connect figma`: stores a Figma personal
// access token locally for `gnt prebrain --figma-comments` to use. Not an
// MCP-in connector -- see ../prebrain/figma-comments.ts's own doc comment
// -- so this doesn't go through mcp-framework's runConnectFlow, which is
// typed around the MCP adapter shape. Shaped instead like connect-github.ts's
// own hand-written interactive command (its own masked-input reader, no
// adapter object) but keeping notion-mcp/monday-mcp's trust model rather
// than connect-github.ts's: gnt's own backend is never in this token's
// path (unlike connect-github.ts's PAT, which gnt's backend stores to
// operate the GitHub integration itself), so this writes only to this
// device's own ~/.gnt/mcp-tokens.json, the same local vault the MCP-in
// connectors already use.
import { emitKeypressEvents, type Key } from "node:readline";
import { deleteMcpToken, saveMcpToken } from "../credentials.js";
import { FIGMA_TOKEN_ID, validateFigmaToken } from "../prebrain/figma-comments.js";
import { dim, fail, muted, ok } from "../theme.js";

// Identical shape to connect-github.ts's own readMaskedLine -- copied
// rather than shared, the same choice connect-github.ts already made over
// building a reusable version, so this file keeps zero dependency on the
// MCP-in connector framework (mcp-framework/connect.ts's own
// readMaskedToken lives there for a reason: it's part of that framework's
// shared surface, not a general-purpose utility this file should reach
// into).
function readMaskedLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("gnt connect figma needs an interactive terminal."));
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

export async function connectFigma(): Promise<void> {
  console.log(
    muted(
      "Create a personal access token at figma.com -> account settings -> Personal access tokens, " +
        "scoped to read file comments, then paste it below.",
    ),
  );

  let token: string;
  try {
    token = await readMaskedLine(muted("Figma personal access token: "));
  } catch (err) {
    console.error(fail(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  if (!token) {
    console.error(fail("No token entered."));
    process.exit(1);
  }

  console.log(muted("Checking the Figma connection with one read before saving..."));
  try {
    await validateFigmaToken(token);
  } catch (err) {
    console.error(
      fail(`Couldn't reach Figma with that token, nothing saved: ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exit(1);
  }

  saveMcpToken(FIGMA_TOKEN_ID, token);
  console.log(ok("Saved. Run `gnt prebrain --figma-comments --figma-files <file-key[,file-key...]>` to read from it."));
  console.log(dim("This token is stored only on this device (~/.gnt/mcp-tokens.json) -- gnt's servers never see it."));
}

// `gnt disconnect figma`. Purely local, same as every disconnect in this
// CLI's mcp-tokens.json world: a personal access token is customer-issued,
// with no revoke API for gnt to call, so removing the local copy is the
// whole of disconnect here.
export async function disconnectFigma(): Promise<void> {
  const removed = deleteMcpToken(FIGMA_TOKEN_ID);
  if (removed) {
    console.log(ok("Disconnected Figma. The local token has been removed."));
  } else {
    console.log(muted("No stored Figma connection to remove."));
  }
}

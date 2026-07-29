// `gnt connect monday-mcp`: stores a monday.com API
// token locally for `gnt prebrain --mcp-monday` to use. Built on the
// connector framework's shared runConnectFlow (mcp-framework/connect.ts)
// rather than a hand-written saveMcpToken call -- runConnectFlow validates
// the token with one real read before anything is written to disk, so a
// customer never ends up with a saved-but-broken token. Same pattern
// connect-linear-mcp.ts/connect-sentry-mcp.ts/connect-granola-mcp.ts already
// use (this connector predates the framework and originally hand-wrote the
// save; it was later migrated onto runConnectFlow like the
// rest).
//
// -- Why this file supplies its own `validate`, unlike the other three --
// mondayAdapter's declared reads (get_board_items_page, get_updates) are
// both board/item-scoped -- monday.com's API has no workspace-wide "list
// everything" read this connector declares (see mcp-monday.ts's own doc
// comment on why board discovery is deliberately not automatic). The
// adapter's static `probe` field can't carry a board id that only exists
// once a customer supplies one, so runConnectFlow's default validation
// (bare get_board_items_page with no board_id) would fail against a real
// server for every customer -- not a hypothetical, monday's own API
// requires a board to page items from, the same way the walk itself always
// passes one. This command asks for one real board id up front (the same
// kind of id --monday-boards takes later) and validates against that
// specific board, through the same allowlist-enforcing call the framework
// uses internally (callReadOnlyTool) -- still only ever the declared,
// already-allowlisted get_board_items_page, nothing new.
//
// This token authenticates the CLI directly to monday.com -- gnt's servers
// are never in that path (see ../prebrain/mcp-monday.ts's own doc comment)
// -- so this command only writes the token to this device's own
// ~/.gnt/mcp-tokens.json.
import { createInterface } from "node:readline";
import { allowlistOf, callReadOnlyTool, connectStdioMcpServer, runConnectFlow } from "../prebrain/mcp-framework/index.js";
import { mondayAdapter } from "../prebrain/mcp-monday.js";
import { fail, muted } from "../theme.js";

// Same "no TTY -- reject immediately with a clear error" guard every other
// connect command's own line reader has (see connect-datadog.ts's
// readMaskedLine et al.) -- without it, a non-interactive stdin (piped from
// /dev/null, run from a script or CI) leaves this promise unresolved
// forever with nothing else keeping Node's event loop alive, so the
// process just exits 0 silently once the loop drains instead of failing
// with a message.
function readLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error("gnt connect monday-mcp needs an interactive terminal."));
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function connectMondayMcp(): Promise<void> {
  console.log(
    muted(
      "This connector reads item and update content from boards you choose later with --monday-boards. " +
        "To verify the token below actually works, gnt needs one real board id to test a read against first.",
    ),
  );

  let boardId: string;
  try {
    boardId = await readLine(muted("A board id this token can read (find it in the board's URL, e.g. monday.com/boards/<id>): "));
  } catch (err) {
    console.error(fail(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
  if (!boardId) {
    console.error(fail("No board id entered."));
    process.exit(1);
  }

  const saved = await runConnectFlow({
    adapter: mondayAdapter,
    commandName: "gnt connect monday-mcp",
    intro: "Generate an API token from your monday.com avatar -> Developers -> My Access Tokens, then paste it below.",
    tokenPrompt: "monday.com API token: ",
    savedHint: "Run `gnt prebrain --mcp-monday --monday-boards <id[,id...]>` to read from it.",
    // Overrides the adapter's static probe (which has no board id to give
    // get_board_items_page) with a read against the board id just entered
    // -- still the same declared, allowlisted tool, just correctly scoped.
    validate: async (token) => {
      const client = await connectStdioMcpServer(mondayAdapter.server(token));
      try {
        await callReadOnlyTool(client, allowlistOf(mondayAdapter), "get_board_items_page", { board_id: boardId, limit: 1 });
      } finally {
        await client.close();
      }
    },
  });
  if (!saved) process.exit(1);
}

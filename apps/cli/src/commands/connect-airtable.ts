// `gnt connect airtable`: the one connector here whose connect flow
// doubles as its safety mechanism. Every other
// token-based connector here (see ../prebrain/figma-comments.ts,
// ../prebrain/datadog-notebooks.ts) declares which fields are safe to read
// once, in its own source, because the vendor object it reads has a fixed
// shape. An Airtable base's fields are entirely customer-defined, so this
// command is interactive and multi-step instead of the usual
// single-token-paste flow every other `gnt connect <x>` command in this CLI
// uses: paste a token, pick a base, see that base's real tables and fields
// live, and explicitly choose which fields per table are safe prose. That
// last step is mandatory, not a skippable default -- a table nobody
// explicitly picked fields for is saved with an empty allowlist, and
// ../prebrain/airtable.ts's walker refuses to read a table with an empty
// allowlist rather than falling back to reading everything on it. See
// airtable.ts's own top-of-file "Field discipline" section for how that
// saved list becomes a structural read boundary, not just a remembered
// preference.
//
// Not an MCP-in connector, so this doesn't go through mcp-framework's
// runConnectFlow (typed around a single-token credential and a fixed
// probe/save shape neither fits this command's multi-step flow). Shaped
// like connect-datadog.ts's own hand-written interactive command: its own
// masked/plain-line readers, gnt's own backend never in this token's path,
// written only to this device's ~/.gnt/mcp-tokens.json.
import { emitKeypressEvents, type Key } from "node:readline";
import { deleteMcpToken, saveMcpToken } from "../credentials.js";
import {
  AIRTABLE_TOKEN_ID,
  type AirtableBaseSummary,
  type AirtableConnectorConfig,
  type AirtableTableSelection,
  getBaseSchema,
  listAccessibleBases,
  PROSE_SHAPED_FIELD_TYPES,
  serializeAirtableConfig,
} from "../prebrain/airtable.js";
import { bold, dim, fail, muted, ok } from "../theme.js";

// Identical shape to connect-datadog.ts's own readMaskedLine -- copied
// rather than shared, same reasoning that file gives for its own copy: no
// dependency on mcp-framework/connect.ts's readMaskedToken, since this
// isn't an MCP-in connector.
function readMaskedLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("gnt connect airtable needs an interactive terminal."));
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

// Same reader as readMaskedLine, echoing what's typed instead of masking
// it -- used for every prompt in this flow after the token itself (base
// picks, y/N table prompts, field-number selections), none of which are
// secrets.
function readPlainLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("gnt connect airtable needs an interactive terminal."));
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

// Pure, testable: does raw start with y/Y/yes (case-insensitive)? Blank
// input takes defaultValue rather than being treated as a typo.
export function parseYesNo(raw: string, defaultValue = false): boolean {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return defaultValue;
  return trimmed === "y" || trimmed === "yes";
}

// Pure, testable: parses a comma-separated 1-indexed field selection
// ("2,4") against a table's own field count, into a deduplicated,
// selection-order list of valid indices. An out-of-range or non-numeric
// token is dropped, not treated as fatal to the rest of the selection --
// same "skip the bad entry" bias every parser in this codebase already
// has, so one typo mid-list doesn't cost the other fields the customer
// meant to pick.
export function parseIndexSelection(raw: string, fieldCount: number): number[] {
  const seen = new Set<number>();
  const indices: number[] = [];
  for (const part of raw.split(",")) {
    const n = Number.parseInt(part.trim(), 10);
    if (!Number.isInteger(n) || n < 1 || n > fieldCount || seen.has(n)) continue;
    seen.add(n);
    indices.push(n);
  }
  return indices;
}

export interface ConnectAirtableOptions {
  /** Skips the interactive base picker when the base is already known -- see this command's own top-of-file doc comment, step (b). */
  airtableBase?: string;
}

export async function connectAirtable(options: ConnectAirtableOptions = {}): Promise<void> {
  console.log(
    muted(
      "Create a personal access token at airtable.com/create/tokens with the schema.bases:read and " +
        "data.records:read scopes, added to every base you want to connect, then paste it below.",
    ),
  );

  let token: string;
  try {
    token = await readMaskedLine(muted("Airtable personal access token: "));
  } catch (err) {
    console.error(fail(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
  if (!token) {
    console.error(fail("No token entered."));
    process.exit(1);
  }

  console.log(muted("Checking the Airtable connection and listing bases this token can access..."));
  let bases: AirtableBaseSummary[];
  try {
    bases = await listAccessibleBases(token);
  } catch (err) {
    console.error(
      fail(`Couldn't reach Airtable with that token, nothing saved: ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exit(1);
  }
  if (bases.length === 0) {
    console.error(
      fail("That token can't see any bases -- add it to at least one base at airtable.com/create/tokens, nothing saved."),
    );
    process.exit(1);
  }

  let base = bases[0];
  if (options.airtableBase) {
    const found = bases.find((b) => b.id === options.airtableBase);
    if (!found) {
      console.error(fail(`--airtable-base ${options.airtableBase} isn't a base this token can access, nothing saved.`));
      process.exit(1);
    }
    base = found;
  } else if (bases.length > 1) {
    console.log(bold("Bases this token can access:"));
    for (const [i, b] of bases.entries()) {
      console.log(`  ${i + 1}. ${b.name} ${dim(`(${b.id})`)}`);
    }
    let baseChoice: string;
    try {
      baseChoice = await readPlainLine(muted(`Pick a base [1-${bases.length}]: `));
    } catch (err) {
      console.error(fail(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
    const index = Number.parseInt(baseChoice.trim(), 10);
    if (!Number.isInteger(index) || index < 1 || index > bases.length) {
      console.error(fail("Not a valid choice, nothing saved."));
      process.exit(1);
    }
    base = bases[index - 1];
  }

  console.log(muted(`Reading ${base.name}'s live schema...`));
  let schema: Awaited<ReturnType<typeof getBaseSchema>>;
  try {
    schema = await getBaseSchema(base.id, token);
  } catch (err) {
    console.error(
      fail(`Couldn't read ${base.name}'s schema, nothing saved: ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exit(1);
  }
  if (schema.length === 0) {
    console.error(fail(`${base.name} has no tables gnt can see -- nothing to connect. Nothing saved.`));
    process.exit(1);
  }

  console.log();
  console.log(bold(`${base.name}: ${schema.length} table${schema.length === 1 ? "" : "s"}`));
  console.log(
    dim(
      "For each table you want scanned, pick exactly which fields are safe prose. A table you skip, or leave with " +
        "no fields picked, is never read.",
    ),
  );

  const tables: AirtableTableSelection[] = [];
  for (const tableSchema of schema) {
    console.log();
    let includeRaw: string;
    try {
      includeRaw = await readPlainLine(
        muted(`Include table "${tableSchema.name}" (${tableSchema.fields.length} fields)? [y/N]: `),
      );
    } catch (err) {
      console.error(fail(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
    if (!parseYesNo(includeRaw)) continue;

    console.log(bold(`  Fields in "${tableSchema.name}":`));
    for (const [i, field] of tableSchema.fields.entries()) {
      const hint = PROSE_SHAPED_FIELD_TYPES.has(field.type) ? dim(" (recommended: long text)") : "";
      console.log(`    ${i + 1}. ${field.name} ${dim(`[${field.type}]`)}${hint}`);
    }

    let fieldsRaw: string;
    try {
      fieldsRaw = await readPlainLine(
        muted("  Comma-separated field numbers to save as safe prose (blank to skip this table): "),
      );
    } catch (err) {
      console.error(fail(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }

    const indices = parseIndexSelection(fieldsRaw, tableSchema.fields.length);
    if (indices.length === 0) {
      console.log(dim(`  No fields picked for "${tableSchema.name}" -- gnt prebrain will never read this table.`));
      continue;
    }

    const allowedFields = indices.map((i) => tableSchema.fields[i - 1].name);
    console.log(ok(`  Saved: ${allowedFields.join(", ")}`));
    tables.push({ tableId: tableSchema.id, tableName: tableSchema.name, allowedFields });
  }

  const config: AirtableConnectorConfig = { token, baseId: base.id, baseName: base.name, tables };
  saveMcpToken(AIRTABLE_TOKEN_ID, serializeAirtableConfig(config));

  console.log();
  if (tables.length === 0) {
    console.log(
      fail(
        "Saved, but no table has any fields selected -- `gnt prebrain --airtable` will read nothing until you " +
          "run `gnt connect airtable` again and pick at least one field on at least one table.",
      ),
    );
  } else {
    console.log(
      ok(`Saved. ${tables.length} table${tables.length === 1 ? "" : "s"} connected. Run \`gnt prebrain --airtable\` to read from ${base.name}.`),
    );
  }
  console.log(
    dim("This token and field selection are stored only on this device (~/.gnt/mcp-tokens.json) -- gnt's servers never see them."),
  );
}

// `gnt disconnect airtable`. Purely local, same as every disconnect in
// this CLI's mcp-tokens.json world: a personal access token is customer-
// issued, with no revoke API for gnt to call the way mcp-framework's
// runDisconnectFlow calls one for a vendor that has one, so removing the
// local copy is the whole of disconnect here. Deletes the base, table, and
// field selection along with the token -- they were saved as one JSON
// envelope under AIRTABLE_TOKEN_ID (see AirtableConnectorConfig), so there
// is nothing left to disconnect independently. Same message shape as
// runDisconnectFlow's own ok/muted pair, for one voice across every
// connector's disconnect output.
export async function disconnectAirtable(): Promise<void> {
  const removed = deleteMcpToken(AIRTABLE_TOKEN_ID);
  if (removed) {
    console.log(ok("Disconnected Airtable. The local token, base, and field selection have been removed."));
  } else {
    console.log(muted("No stored Airtable connection to remove."));
  }
}

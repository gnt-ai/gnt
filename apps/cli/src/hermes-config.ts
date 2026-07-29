// Pure text-editing logic behind `gnt connect hermes`, split out of
// commands/connect-hermes.ts so it's testable without a filesystem or a
// terminal.
//
// Hermes Agent (github.com/NousResearch/hermes-agent) reads its MCP server
// list from ~/.hermes/config.yaml under a top-level `mcp_servers:` key --
// each entry either a stdio server (`command`/`args`/`env`) or an HTTP
// server (`url`/`headers`), per Hermes's own MCP Config Reference docs.
// This inserts one HTTP entry, named `gnt`, pointing at gnt's published
// MCP endpoint.
//
// This edits the file as text rather than parsing and re-emitting it with
// a YAML library. config.yaml is the user's own file -- it may already
// list other MCP servers, comments, and settings this command has no
// business touching, and a full parse-then-dump round trip would drop
// comments and can reorder keys. A targeted insertion leaves everything
// else in the file byte-for-byte untouched.
//
// The one thing a text insertion has to get right that a YAML library
// would get right for free: sibling keys in a YAML block mapping must
// share the same indentation width, or the parser nests them wrong. So
// this detects the indentation an existing `mcp_servers:` block already
// uses (from its first child key) and matches it, instead of assuming
// two spaces.
//
// The Authorization header is always the literal string
// "Bearer ${GNT_MCP_KEY}", never a real key -- Hermes resolves ${VAR_NAME}
// references inside config.yaml string values against the process
// environment (falling back to ~/.hermes/.env), confirmed against Hermes's
// own configuration.md and the header example in its published
// cli-config.yaml.example ("CF-Access-Client-Secret: ${CF_ACCESS_SECRET}").
// So the real key never touches disk in plaintext here, the same guidance
// OpenClaw's own docs give and the same env var name gnt's OpenClaw
// connector already settled on (see connect-openclaw.ts), so a customer
// running both only has one variable to manage. The connect command
// prints the minted key once and tells the customer to export it (or add
// it to ~/.hermes/.env, Hermes's own documented place for secrets)
// instead of writing it into config.yaml.

import { homedir } from "node:os";
import { join } from "node:path";
import { MCP_URL } from "./config.js";

export const HERMES_DIR = join(homedir(), ".hermes");
export const HERMES_CONFIG_PATH = join(HERMES_DIR, "config.yaml");

// Matches OpenClaw's own connector (connect-openclaw.ts) -- one env var
// name across both integrations, not a Hermes-specific one, so a customer
// running both harnesses manages a single secret.
export const GNT_KEY_ENV_VAR = "GNT_MCP_KEY";

// The only gnt tools Hermes needs: the enforcement call plus the
// human-approved retrieval surface it's built on. Matches TOOLS in
// apps/web/app/docs/page.tsx exactly -- same five tools, same order.
export const GNT_TOOL_NAMES = ["check_action", "search_rules", "get_rule", "list_skill_packs", "get_skill_pack"];

interface McpServersBlock {
  headerIndex: number;
  // First line index after the block that's back at column 0 (or
  // lines.length if the block runs to EOF).
  endIndex: number;
  // The indentation of the block's first child key, reused for gnt's own
  // entry so it stays a sibling. Falls back to two spaces (Hermes's own
  // documented convention) when the block exists but has no children yet.
  indent: string;
}

export function locateMcpServersBlock(lines: string[]): McpServersBlock | null {
  const headerIndex = lines.findIndex((line) => /^mcp_servers:\s*$/.test(line));
  if (headerIndex === -1) return null;

  let indent: string | null = null;
  let endIndex = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) {
      endIndex = i;
      break;
    }
    if (indent === null) {
      const match = line.match(/^(\s+)\S/);
      if (match) indent = match[1];
    }
  }
  return { headerIndex, endIndex, indent: indent ?? "  " };
}

// True when the block already has a direct `gnt:` child (not nested
// deeper, under some other server) -- checked by indentation width, not
// just presence of the string, so a server literally named "gnt-mirror"
// or a mention inside a comment doesn't false-positive.
export function hasExistingGntServer(lines: string[], block: McpServersBlock): boolean {
  for (let i = block.headerIndex + 1; i < block.endIndex; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const leading = line.match(/^(\s*)/)?.[1] ?? "";
    if (leading.length === block.indent.length && line.trim() === "gnt:") return true;
  }
  return false;
}

// Lines for the gnt server entry itself, indented one level under
// `mcp_servers:` (using `indent` as the unit, nested by repeating it) --
// no `mcp_servers:` header line included, callers place that separately
// depending on whether one already exists. Always the ${GNT_MCP_KEY}
// placeholder (see this file's own doc comment) -- there is no "real key"
// variant, so what's shown for consent is byte-for-byte what gets written.
export function gntServerLines(indent: string): string[] {
  const child = indent;
  const grandchild = indent + indent;
  return [
    `${child}gnt:`,
    `${grandchild}url: "${MCP_URL}"`,
    `${grandchild}headers:`,
    `${grandchild}${indent}Authorization: "Bearer \${${GNT_KEY_ENV_VAR}}"`,
    `${grandchild}tools:`,
    `${grandchild}${indent}include: [${GNT_TOOL_NAMES.join(", ")}]`,
    `${grandchild}${indent}resources: false`,
    `${grandchild}${indent}prompts: false`,
  ];
}

export type AddGntServerResult =
  | { status: "already-connected" }
  | { status: "ready"; preview: string[]; apply: () => string };

// Only handles the block-style YAML this file's own doc comment assumes
// (what Hermes's installer and `hermes mcp add` both actually produce) --
// a hand-edited `mcp_servers: {}` flow-style empty mapping wouldn't be
// recognized as an existing block and would get a second `mcp_servers:`
// key appended below it instead of being filled in. Vendor-generated
// configs don't do this; it's a known, narrow gap, not a silent one.
//
// Figures out what would change, without touching the filesystem --
// `preview` and `apply()` produce identical content, since nothing here
// depends on a real key.
export function planAddGntServer(existingConfig: string): AddGntServerResult {
  // Drop exactly one trailing newline before splitting, so a normal
  // file (which ends in "\n") doesn't leave a spurious empty "line" at
  // the end of the array -- splice()ing at that position would otherwise
  // insert the new block after a blank line that shouldn't be there.
  const trimmedConfig = existingConfig.replace(/\n$/, "");
  const lines = trimmedConfig.length > 0 ? trimmedConfig.split("\n") : [];
  const block = locateMcpServersBlock(lines);

  if (block && hasExistingGntServer(lines, block)) {
    return { status: "already-connected" };
  }

  const indent = block?.indent ?? "  ";
  const finalLines = gntServerLines(indent);
  const preview = block ? finalLines : ["mcp_servers:", ...finalLines];

  return {
    status: "ready",
    preview,
    apply(): string {
      if (block) {
        const updated = [...lines];
        updated.splice(block.endIndex, 0, ...finalLines);
        return `${updated.join("\n")}\n`;
      }

      if (lines.length === 0) {
        return `${preview.join("\n")}\n`;
      }
      return `${lines.join("\n")}\n\n${preview.join("\n")}\n`;
    },
  };
}

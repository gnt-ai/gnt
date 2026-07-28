import type { Command, Help, Option } from "commander";
import { bold, muted, text } from "./theme.js";

// Aligns a term/description pair list on the longest term — same idea as
// theme.ts's keyValueLines, but without the trailing colon (a command or
// option name isn't a label:value pair).
function alignedRows(rows: Array<[string, string]>): string[] {
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map(([term]) => term.length));
  return rows.map(([term, description]) =>
    description ? `  ${text(term.padEnd(width))}  ${muted(description)}` : `  ${text(term)}`,
  );
}

// `gnt prebrain --help` alone has 60+ flags -- one flat alphabetical list
// makes it unreadable even though most people only ever need --all or one
// or two connector flags. Groups by connector instead, matched by a
// keyword each connector's own flags already share (--mcp-notion/
// --notion-*, --mcp-monday/--monday-*, and so on) -- order here is also
// the order groups render in. Every other command has few enough options
// that this never kicks in (see formatHelp's options.length gate below).
const PREBRAIN_OPTION_GROUPS: Array<[label: string, keyword: string]> = [
  ["Notion", "notion"],
  ["monday.com", "monday"],
  ["Linear", "linear"],
  ["Jira", "jira"],
  ["Sentry", "sentry"],
  ["Granola", "granola"],
  ["Zoom", "zoom"],
  ["Figma", "figma"],
  ["Datadog", "datadog"],
  ["GitLab", "gitlab"],
  ["HubSpot", "hubspot"],
  ["Airtable", "airtable"],
];

function groupedOptionRows(options: Option[], helper: Help): string[] {
  const rowFor = (o: Option): [string, string] => [helper.optionTerm(o), helper.optionDescription(o)];
  const remaining = new Set(options);
  const lines: string[] = [];

  const general = options.filter((o) => !/notion|monday|linear|jira|sentry|granola|zoom|figma|datadog|gitlab|hubspot|airtable/i.test(o.flags));
  if (general.length > 0) {
    lines.push(...alignedRows(general.map(rowFor)));
    general.forEach((o) => remaining.delete(o));
  }

  for (const [label, keyword] of PREBRAIN_OPTION_GROUPS) {
    const group = options.filter((o) => remaining.has(o) && new RegExp(keyword, "i").test(o.flags));
    if (group.length === 0) continue;
    lines.push("", muted(`  ${label}`));
    lines.push(...alignedRows(group.map(rowFor)));
    group.forEach((o) => remaining.delete(o));
  }

  return lines;
}

// Commander's own default help formatter is plain, uncolored text --
// replaces it so `gnt`/`gnt --help`/`gnt <command> --help` all match the
// rest of the CLI's theme instead of being the one unstyled surface left.
// Set once via program.configureHelp() before any subcommands are defined,
// so every subcommand inherits it (Command copies _helpConfiguration at
// the point .command() creates it).
export function formatHelp(cmd: Command, helper: Help): string {
  const lines: string[] = [];

  lines.push(`${muted("[")} ${bold("gnt.ai")} ${muted("]")}`);
  const description = helper.commandDescription(cmd);
  if (description) lines.push(muted(description));
  lines.push("");

  lines.push(`${muted("Usage:")} ${text(helper.commandUsage(cmd))}`);

  const args = helper.visibleArguments(cmd);
  if (args.length > 0) {
    lines.push("", muted("ARGUMENTS"));
    lines.push(...alignedRows(args.map((a) => [helper.argumentTerm(a), helper.argumentDescription(a)])));
  }

  const commands = helper.visibleCommands(cmd);
  if (commands.length > 0) {
    lines.push("", muted("COMMANDS"));
    lines.push(
      ...alignedRows(commands.map((c) => [helper.subcommandTerm(c), helper.subcommandDescription(c)])),
    );
  }

  const options = helper.visibleOptions(cmd);
  if (options.length > 0) {
    lines.push("", muted("OPTIONS"));
    // Only prebrain has enough flags for a flat list to become a wall of
    // text -- everything else keeps the plain aligned listing.
    lines.push(
      ...(options.length > 15
        ? groupedOptionRows(options, helper)
        : alignedRows(options.map((o) => [helper.optionTerm(o), helper.optionDescription(o)]))),
    );
  }

  return `${lines.join("\n")}\n`;
}

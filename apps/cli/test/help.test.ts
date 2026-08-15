// Coverage for help.ts's custom Commander formatter: the branded header,
// the section layout (ARGUMENTS / COMMANDS / OPTIONS), and the
// prebrain-only grouped-options path -- 60+ connector flags become
// unreadable as one flat list, so anything that breaks the grouping or
// the ordering quietly regresses the one surface every user sees.
import { Command } from "commander";
import { expect, test } from "bun:test";
import { formatHelp } from "../src/help.js";

// eslint-disable-next-line no-control-regex -- test assertions compare visible CLI output
const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (s: string): string => s.replace(ANSI, "");
// formatHelp always ends with a newline, so drop the empty trailing element.
const lines = (cmd: Command): string[] => plain(formatHelp(cmd, cmd.createHelp())).split("\n").slice(0, -1);

// Rows under a section header, stopping at the blank line that precedes the
// next all-caps section header (OPTIONS is the last section, so it runs to
// the end of the output).
function section(cmd: Command, header: string): string[] {
  const out = lines(cmd);
  const start = out.indexOf(header);
  if (start < 0) return [];
  const rest = out.slice(start + 1);
  const end = rest.findIndex((line, i) => line === "" && /^[A-Z]+$/.test(rest[i + 1] ?? ""));
  return end === -1 ? rest : rest.slice(0, end);
}

test("formatHelp renders the branded header, description, and usage", () => {
  const cmd = new Command().name("gnt").description("The gnt CLI");
  const out = lines(cmd);
  expect(out[0]).toBe("[ gnt.ai ]");
  expect(out[1]).toBe("The gnt CLI");
  expect(out[3]).toBe("Usage: gnt [options]");
});

test("formatHelp omits ARGUMENTS and COMMANDS sections when there is nothing to show", () => {
  const cmd = new Command().name("gnt");
  const out = lines(cmd).join("\n");
  expect(out).not.toContain("ARGUMENTS");
  expect(out).not.toContain("COMMANDS");
  expect(out).toContain("OPTIONS"); // -h, --help is always present
});

test("formatHelp aligns ARGUMENTS rows on the longest argument term", () => {
  const cmd = new Command()
    .name("gnt")
    .argument("<first>", "short")
    .argument("<much-longer-name>", "longer");
  expect(section(cmd, "ARGUMENTS")).toEqual([
    "  first             short",
    "  much-longer-name  longer",
  ]);
});

test("formatHelp lists COMMANDS with the auto-added help command aligned last", () => {
  const cmd = new Command()
    .name("gnt")
    .addCommand(new Command().name("one").description("first command"))
    .addCommand(new Command().name("two").description("second command"));
  expect(section(cmd, "COMMANDS")).toEqual([
    "  one             first command",
    "  two             second command",
    "  help [command]  display help for command",
  ]);
});

test("formatHelp renders a description-less option without the padded description column", () => {
  const cmd = new Command().name("gnt").option("-q, --quiet");
  expect(section(cmd, "OPTIONS")).toEqual([
    "  -q, --quiet",
    "  -h, --help   display help for command",
  ]);
});

test("formatHelp keeps a flat aligned OPTIONS list until the prebrain threshold", () => {
  const cmd = new Command().name("gnt");
  for (let i = 0; i < 5; i++) cmd.option(`--flag-${i} <value>`, `flag ${i}`);
  const options = section(cmd, "OPTIONS");
  expect(options).toEqual([
    "  --flag-0 <value>  flag 0",
    "  --flag-1 <value>  flag 1",
    "  --flag-2 <value>  flag 2",
    "  --flag-3 <value>  flag 3",
    "  --flag-4 <value>  flag 4",
    "  -h, --help        display help for command",
  ]);
});

test("formatHelp groups prebrain-style options by connector when there are more than 15", () => {
  const cmd = new Command().name("gnt prebrain");
  cmd.option("--all", "run all connectors");
  for (let i = 0; i < 12; i++) cmd.option(`--generic-${i}`, `generic option ${i}`);
  cmd.option("--mcp-notion <token>", "Notion MCP token");
  cmd.option("--mcp-jira <token>", "Jira MCP token");
  const options = section(cmd, "OPTIONS");
  // General options (everything not matching a connector keyword) come first,
  // in declaration order with the auto-added -h, --help row last.
  expect(options[0]).toBe("  --all         run all connectors");
  expect(options[options.length - 1]).toBe("  --mcp-jira <token>  Jira MCP token");
  // Connector groups render in PREBRAIN_OPTION_GROUPS order with their headers.
  const notion = options.indexOf("  Notion");
  const jira = options.indexOf("  Jira");
  expect(notion).toBeGreaterThan(-1);
  expect(jira).toBeGreaterThan(notion);
  expect(options[notion + 1]).toBe("  --mcp-notion <token>  Notion MCP token");
  // The general bucket is separated from the groups by a blank line.
  expect(options[notion - 1]).toBe("");
});

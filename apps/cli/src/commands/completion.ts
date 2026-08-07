import type { Command } from "commander";
import { fail } from "../theme.js";

const SHELLS = ["bash", "zsh", "fish"] as const;
type Shell = (typeof SHELLS)[number];

function isShell(value: string): value is Shell {
  return (SHELLS as readonly string[]).includes(value);
}

// Read the live command tree instead of hardcoding a duplicate list, so a
// new .command() in index.ts shows up in completions without a second edit.
function commandTree(program: Command): Map<string, string[]> {
  const tree = new Map<string, string[]>();
  for (const cmd of program.commands) {
    if (cmd.name() === "help") continue;
    tree.set(
      cmd.name(),
      cmd.commands.filter((sub) => sub.name() !== "help").map((sub) => sub.name()),
    );
  }
  return tree;
}

function bashScript(tree: Map<string, string[]>): string {
  const top = [...tree.keys()].join(" ");
  const cases = [...tree.entries()]
    .filter(([, subs]) => subs.length > 0)
    .map(([name, subs]) => `    ${name}) COMPREPLY=($(compgen -W "${subs.join(" ")}" -- "$cur")) ;;`)
    .join("\n");
  return `_gnt_completions() {
  local cur
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${top}" -- "$cur"))
    return
  fi
  case "\${COMP_WORDS[1]}" in
${cases}
  esac
}
complete -F _gnt_completions gnt
`;
}

function zshScript(tree: Map<string, string[]>): string {
  const top = [...tree.keys()].join(" ");
  const cases = [...tree.entries()]
    .filter(([, subs]) => subs.length > 0)
    .map(([name, subs]) => `    ${name}) _values 'subcommand' ${subs.join(" ")} ;;`)
    .join("\n");
  return `#compdef gnt

_gnt() {
  if (( CURRENT == 2 )); then
    _values 'command' ${top}
    return
  fi
  case "\${words[2]}" in
${cases}
  esac
}
_gnt
`;
}

function fishScript(tree: Map<string, string[]>): string {
  const lines = [
    "complete -c gnt -f",
    `complete -c gnt -n "__fish_use_subcommand" -a "${[...tree.keys()].join(" ")}"`,
  ];
  for (const [name, subs] of tree) {
    if (subs.length === 0) continue;
    lines.push(`complete -c gnt -n "__fish_seen_subcommand_from ${name}" -a "${subs.join(" ")}"`);
  }
  return `${lines.join("\n")}\n`;
}

export function completion(shell: string, program: Command): void {
  if (!isShell(shell)) {
    console.error(fail(`Unknown shell "${shell}". Supported: ${SHELLS.join(", ")}.`));
    process.exit(1);
  }

  const tree = commandTree(program);
  switch (shell) {
    case "bash":
      console.log(bashScript(tree));
      break;
    case "zsh":
      console.log(zshScript(tree));
      break;
    case "fish":
      console.log(fishScript(tree));
      break;
  }
}

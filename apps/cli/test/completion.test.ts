import { afterEach, beforeEach, expect, test } from "bun:test";
import { Command } from "commander";
import { completion } from "../src/commands/completion.js";

function fakeProgram(): Command {
  const program = new Command();
  program.command("status").description("Show status");
  const connect = program.command("connect").description("Connect an app");
  connect.command("slack");
  connect.command("github");
  return program;
}

let logs: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let errors: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

test("bash script completes top-level commands and connect's subcommands", () => {
  completion("bash", fakeProgram());

  const output = logs.join("\n");
  expect(output).toContain("complete -F _gnt_completions gnt");
  expect(output).toContain('compgen -W "status connect"');
  expect(output).toContain('connect) COMPREPLY=($(compgen -W "slack github" -- "$cur")) ;;');
});

test("zsh script completes top-level commands and connect's subcommands", () => {
  completion("zsh", fakeProgram());

  const output = logs.join("\n");
  expect(output).toContain("#compdef gnt");
  expect(output).toContain("_values 'command' status connect");
  expect(output).toContain("connect) _values 'subcommand' slack github ;;");
  expect(output).toContain("compdef _gnt gnt");
});

test("fish script completes top-level commands and connect's subcommands", () => {
  completion("fish", fakeProgram());

  const output = logs.join("\n");
  expect(output).toContain('complete -c gnt -n "__fish_use_subcommand" -a "status connect"');
  expect(output).toContain('complete -c gnt -n "__fish_seen_subcommand_from connect" -a "slack github"');
});

test("rejects an unsupported shell without printing a script", () => {
  const originalExit = process.exit;
  const exitCalls: number[] = [];
  // @ts-expect-error -- stubbing process.exit for the test
  process.exit = (code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error("process.exit called");
  };

  try {
    expect(() => completion("powershell", fakeProgram())).toThrow("process.exit called");
  } finally {
    process.exit = originalExit;
  }

  expect(exitCalls).toEqual([1]);
  expect(errors.join("\n")).toContain('Unknown shell "powershell"');
  expect(logs).toEqual([]);
});

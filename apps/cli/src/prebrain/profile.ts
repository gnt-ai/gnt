// The company profile pass. A short interactive
// pass at the very start of `gnt prebrain`: what the company does, which
// functions run on agents, where decisions get made. Answers steer which
// walkers run (2.1), how extracted rules get tagged, and which starter
// packs (2.5) get offered -- this is what makes a run specific to the
// company running it instead of templated.
//
// Local only, by design: "profile answers stay local and inform the run
// only" is the plan's own wording. This module never writes to disk and
// never crosses the network -- not even to ~/.gnt/, which is reserved for
// auth credentials (see ../credentials.ts) and shouldn't accumulate profile
// answers that go stale the moment a company's structure changes.
// Re-asking on every `gnt prebrain` invocation is cheap (four questions)
// and matches "informs the run" more literally than caching a snapshot
// that silently drifts from reality across runs.
import { createInterface } from "node:readline";
import { bold, dim, muted, text } from "../theme.js";

// One function area a company might run AI agents against today. Kept as
// a closed union rather than free text so extraction tagging (2.3) and
// starter-pack filtering (2.5) can match on it programmatically instead of
// parsing prose. Mirrors the pack categories from 2.5 (refunds/escalation,
// discount approvals, engineering conventions, incident response) closely
// enough that a later consumer can map one to the other directly.
export type CompanyFunction = "customer_support" | "sales" | "engineering" | "finance_billing" | "other";

// Where decisions and policy mostly live today, before prebrain gets
// involved. Not consumed by this module -- it's a signal for which walker
// inputs (2.1) are worth pointing at, which is a later integration point
// once the command skeleton and walkers land.
export type DecisionSource = "slack" | "wiki" | "tribal_knowledge" | "other";

// The result of one company-profile pass. This is the contract other
// prebrain tasks (extraction tagging in 2.3, starter-pack selection in
// 2.5) build against once this module merges -- every field is structured
// enough to filter or branch on, never a blob of free text nobody can
// query.
export interface CompanyProfile {
  // Free-text one-liner: what the company does. Carried through as
  // context on extracted rules, not deeply parsed by this module.
  description: string;
  // Which functions currently run on (or are slated to run on) AI agents.
  // Empty when the company picked none. Drives starter-pack filtering
  // (2.5) and the function tag on extracted rules.
  agentFunctions: CompanyFunction[];
  // The single function worth prioritizing first, when more than one was
  // picked. Null when agentFunctions has 0 or 1 entries -- there's
  // nothing to disambiguate in that case.
  primaryFunction: CompanyFunction | null;
  // Where decisions and policy mostly get made or written down today.
  decisionSource: DecisionSource;
}

// Abstracts "ask a question at the terminal, get an answer back" so the
// question logic below can run against a real terminal in production and
// a scripted queue of answers in tests, without either side reaching into
// process.stdin. Mirrors connect-github.ts's readLine contract (prompt in,
// trimmed answer out) so the two interactive flows in this CLI behave the
// same way from a caller's perspective.
export type Ask = (prompt: string) => Promise<string>;

// Exported alongside CompanyProfile's own Option-list plumbing so the
// source-picker pass (source-picker.ts) reuses the exact same
// comma-separated multi-select/free-text behavior instead of a second,
// subtly-different implementation -- this file happens to be where it
// was first written, not a claim that it's profile-specific.
export interface Option<T> {
  value: T;
  label: string;
}

const FUNCTION_OPTIONS: Option<CompanyFunction>[] = [
  { value: "customer_support", label: "Customer support" },
  { value: "sales", label: "Sales" },
  { value: "engineering", label: "Engineering" },
  { value: "finance_billing", label: "Finance / billing" },
  { value: "other", label: "Other / not sure yet" },
];

const DECISION_OPTIONS: Option<DecisionSource>[] = [
  { value: "slack", label: "Slack" },
  { value: "wiki", label: "A wiki or internal docs" },
  { value: "tribal_knowledge", label: "Tribal knowledge -- mostly undocumented" },
  { value: "other", label: "Somewhere else" },
];

function printOptions<T>(options: Option<T>[]): void {
  for (const [i, option] of options.entries()) {
    console.log(`  ${dim(`${i + 1}.`)} ${text(option.label)}`);
  }
}

// Accepts "1", "1,3", "1 3", "1, 3" -- whatever's fastest to type at a
// terminal. Out-of-range or non-numeric tokens are dropped rather than
// rejected outright: fat-fingering one digit in a list shouldn't force a
// company to restart the whole pass. Order follows the option list, not
// input order, and duplicates collapse, so the result is deterministic
// regardless of how the answer was typed.
function parseIndexes(raw: string, max: number): number[] {
  const picked = new Set<number>();
  for (const token of raw.split(/[,\s]+/)) {
    const n = Number.parseInt(token, 10);
    if (Number.isInteger(n) && n >= 1 && n <= max) picked.add(n);
  }
  return [...picked].sort((a, b) => a - b);
}

export async function askMultiSelect<T>(ask: Ask, prompt: string, options: Option<T>[]): Promise<T[]> {
  console.log(`\n${bold(prompt)}`);
  printOptions(options);
  const raw = await ask(muted("  > "));
  return parseIndexes(raw, options.length).map((i) => options[i - 1].value);
}

async function askSingleSelect<T>(
  ask: Ask,
  prompt: string,
  options: Option<T>[],
  fallback: T,
): Promise<T> {
  console.log(`\n${bold(prompt)}`);
  printOptions(options);
  const raw = await ask(muted("  > "));
  const [first] = parseIndexes(raw, options.length);
  return first === undefined ? fallback : options[first - 1].value;
}

export async function askFreeText(ask: Ask, prompt: string): Promise<string> {
  console.log(`\n${bold(prompt)}`);
  return ask(muted("  > "));
}

// Only asked when there's an actual choice to prioritize between -- with 0
// or 1 functions picked, agentFunctions already answers "what's first."
async function askPrimaryFunction(
  ask: Ask,
  picked: CompanyFunction[],
): Promise<CompanyFunction | null> {
  if (picked.length <= 1) return picked[0] ?? null;
  const options = FUNCTION_OPTIONS.filter((option) => picked.includes(option.value));
  return askSingleSelect(
    ask,
    "Which of those is the top priority to get rules for first?",
    options,
    picked[0],
  );
}

// Runs the (up to) four-question pass and returns a structured
// CompanyProfile. Takes an Ask rather than touching process.stdin/stdout
// directly so tests can feed scripted answers and assert on the result --
// see test/prebrain-profile.test.ts.
export async function collectCompanyProfile(ask: Ask): Promise<CompanyProfile> {
  console.log(text("\nA few questions before prebrain runs -- under a minute, stays on this machine.\n"));

  const description = await askFreeText(ask, "In one line, what does your company do?");
  const agentFunctions = await askMultiSelect(
    ask,
    "Which functions currently run on AI agents, or will soon? (comma-separated, blank for none)",
    FUNCTION_OPTIONS,
  );
  const primaryFunction = await askPrimaryFunction(ask, agentFunctions);
  const decisionSource = await askSingleSelect(
    ask,
    "Where do decisions and policy mostly get made or written down?",
    DECISION_OPTIONS,
    "other",
  );

  return { description, agentFunctions, primaryFunction, decisionSource };
}

// Default Ask backing runCompanyProfile below -- same shape as
// connect-github.ts's readLine (fresh readline interface per question,
// closed immediately after), kept local to this file since it's the only
// other command with an interactive text prompt and neither is big enough
// yet to justify a shared readline helper module.
//
// Same "no TTY -- reject immediately" guard every connect command's own
// line reader has (see connect-datadog.ts's readMaskedLine et al.).
// Without it, a non-interactive stdin (piped from /dev/null, or `gnt
// prebrain` run by an agent/script/CI with no real terminal attached --
// exactly the "hand setup to an agent" path this CLI is built for) leaves
// this promise unresolved forever with nothing else keeping Node's event
// loop alive, so the whole prebrain run exits 0 silently right after
// finding real candidate chunks, instead of failing with a message.
function readLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error("gnt prebrain's company-profile questions need an interactive terminal."));
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Real entry point: collects the profile at a live terminal. `gnt
// prebrain`'s command wiring (2.1, landing separately) calls this
// directly; nothing in this repo calls it yet.
export function runCompanyProfile(): Promise<CompanyProfile> {
  return collectCompanyProfile(readLine);
}

// Starter rule packs: curated, editable starting-point
// rules for orgs whose local sources (repo-scan/docs-dir/notion-export)
// are too thin for real extraction (2.1-2.4) to find much from. Content
// lives in ../../../starter-packs/packs.jsonl, not inline in this file --
// same "content lives as data" convention as apps/api/eval/rule_retrieval/
// corpus.jsonl and this package's own eval/privacy-gate/corpus.jsonl, so a
// human (the founder) can review and edit pack wording without touching
// code.
//
// These rules never go through the privacy gate or model extraction --
// they're already-written, generic policy text with no local file behind
// them, not raw customer prose that needs masking or a model call to turn
// into a rule. They join runPrebrain's pipeline at the same point real
// extraction's output does: an ExtractedRule[] ready for groupByTopic /
// create / submit / batch-propose (see commands/prebrain.ts).
//
// Every rule's body must read as an obviously generic, editable starting
// point, never as a stated fact about a real company's actual policy --
// that's this task's core honesty constraint, not a formality. assertHedged
// enforces a cheap heuristic for it (a hedge-language marker somewhere in
// the body) at load time, so a hand-edited packs.jsonl that drifts into
// "Refunds are issued within 30 days" (stated as settled fact) fails fast
// instead of silently shipping to a customer's rules repo.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractedRule } from "../extraction/types.js";

// This file lives at src/prebrain/starter-packs/index.ts (compiled to
// dist/prebrain/starter-packs/index.js, same relative depth) -- three
// levels up from either lands at the package root, where packs.jsonl
// sits alongside src/ and dist/ (see package.json's "files" field, which
// ships this directory next to dist/ in the published npm package).
const PACKS_FILE = join(dirname(fileURLToPath(import.meta.url)), "../../../starter-packs/packs.jsonl");

export interface StarterPackRule {
  pack: string;
  title: string;
  body: string;
  tags: string[];
}

// Loose but real hedge-language check, not perfect-prose enforcement --
// the goal is catching a rule that reads as a stated fact about some real
// company, not grading writing quality. Every rule in packs.jsonl passes
// this today; it exists to keep that true as the file gets edited.
const HEDGE_MARKERS = [
  /\btypically\b/i,
  /\badjust\b/i,
  /\bedit this\b/i,
  /\byour (own )?/i,
  /\bstarting point\b/i,
  /\bcustomize\b/i,
  /\bverify\b/i,
];

function assertHedged(rule: StarterPackRule): void {
  if (!HEDGE_MARKERS.some((marker) => marker.test(rule.body))) {
    throw new Error(
      `starter pack rule "${rule.title}" (pack: ${rule.pack}) doesn't read as an editable starting point -- ` +
        "body has no hedge language (typically/adjust/edit this/verify/etc). Fix starter-packs/packs.jsonl.",
    );
  }
}

function parsePacksFile(raw: string): StarterPackRule[] {
  const rules: StarterPackRule[] = [];
  for (const [lineNumber, line] of raw.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: Partial<StarterPackRule>;
    try {
      parsed = JSON.parse(trimmed) as Partial<StarterPackRule>;
    } catch (err) {
      throw new Error(`starter-packs/packs.jsonl:${lineNumber + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (
      typeof parsed.pack !== "string" ||
      !parsed.pack ||
      typeof parsed.title !== "string" ||
      !parsed.title ||
      typeof parsed.body !== "string" ||
      !parsed.body ||
      !Array.isArray(parsed.tags)
    ) {
      throw new Error(`starter-packs/packs.jsonl:${lineNumber + 1} is missing a required field (pack/title/body/tags): ${trimmed}`);
    }

    const rule: StarterPackRule = { pack: parsed.pack, title: parsed.title, body: parsed.body, tags: parsed.tags };
    assertHedged(rule);
    rules.push(rule);
  }
  return rules;
}

// Parsed and validated once per process, not once per call -- packs.jsonl
// only changes between releases, never mid-run.
let cachedRules: StarterPackRule[] | null = null;

export function loadAllStarterPackRules(): StarterPackRule[] {
  if (!cachedRules) {
    cachedRules = parsePacksFile(readFileSync(PACKS_FILE, "utf-8"));
  }
  return cachedRules;
}

// Every distinct pack id currently in packs.jsonl, sorted -- used to
// populate `gnt prebrain --help`'s option description and to validate a
// caller's --starter-packs value against real packs rather than a
// hardcoded list that could drift from the data file.
export function listStarterPackIds(): string[] {
  return [...new Set(loadAllStarterPackRules().map((rule) => rule.pack))].sort();
}

// "gnt.ai starter pack: incident-response" -- distinct from prebrain's own
// `source` strings (e.g. "README.md:42-58"), which name a local file this
// tool scanned. A starter-pack rule has no local file behind it, so its
// source string says exactly that: this came from gnt.ai's own curated
// content, not from anything found in the customer's own sources. See
// ExtractedRule.source's doc comment in extraction/types.ts.
function sourceFor(pack: string): string {
  return `gnt.ai starter pack: ${pack}`;
}

// No sourceCitations -- that field is provenance back to a specific
// local file/line-span (see SourceCitation in extraction/types.ts), and a
// starter-pack rule was never extracted from one. confidence is a fixed,
// neutral 0.5 rather than a model-assigned estimate (there's no model
// call here to assign one): high enough that it doesn't read as "probably
// wrong," low enough that it never reads as "confidently verified" -- a
// batch-propose PR's confidence label ("model-assigned estimate -- not a
// verified fact", see routers/rules.py's _batch_pr_section) is slightly
// inaccurate for these rules for that same reason (nothing model-assigned
// it), which is exactly the kind of scope-boundary a reviewer should
// double check, not something this task papers over silently.
function toExtractedRule(rule: StarterPackRule): ExtractedRule {
  return {
    title: rule.title,
    body: rule.body,
    confidence: 0.5,
    tags: rule.tags,
    source: sourceFor(rule.pack),
    sourceCitations: [],
  };
}

export interface StarterPackSelection {
  rules: ExtractedRule[];
  packIds: string[];
  invalidIds: string[];
}

// Parses --starter-packs' raw flag value ("all", or a comma-separated
// list of pack ids) into ExtractedRule[] ready for the same
// groupByTopic/create/submit/batch-propose pipeline real extraction
// output goes through -- see runPrebrain in commands/prebrain.ts.
//
// Deliberately simple and explicit, not auto-magic: this only ever
// returns rules for packs the caller named (or "all" packs, still an
// explicit choice), never rules prebrain decided to add on its own
// because real extraction looked thin. A "thin sources, maybe try
// --starter-packs" hint belongs in runPrebrain's own summary output, not
// in this function silently expanding what it returns.
export function resolveStarterPacks(rawValue: string): StarterPackSelection {
  const all = loadAllStarterPackRules();
  const knownIds = new Set(all.map((rule) => rule.pack));

  const requested =
    rawValue.trim().toLowerCase() === "all"
      ? [...knownIds]
      : rawValue
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);

  const packIds: string[] = [];
  const invalidIds: string[] = [];
  for (const id of requested) {
    if (knownIds.has(id)) {
      if (!packIds.includes(id)) packIds.push(id);
    } else if (!invalidIds.includes(id)) {
      invalidIds.push(id);
    }
  }

  const rules = all.filter((rule) => packIds.includes(rule.pack)).map(toExtractedRule);
  return { rules, packIds, invalidIds };
}

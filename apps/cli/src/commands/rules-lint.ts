import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { load } from "js-yaml";
import { collectFiles } from "../prebrain/text-walker.js";
import { bold, dim, fail, muted, ok, text } from "../theme.js";

const FENCE_OPEN = "---\n";
const FENCE_CLOSE = "\n---\n";

// The 4 persisted states plus pending_merge -- see apps/store/src/core/store.ts's
// RuleStatus and its own note that "rejected" isn't a fifth one.
const RULE_STATUSES = new Set(["draft", "in_review", "pending_merge", "approved", "deprecated"]);

interface LintIssue {
  field: string;
  message: string;
}

// One entry per file walked, in the same order the human-readable path
// prints them. error is set only for file-level failures (an unreadable
// file, a missing/malformed frontmatter fence); issues holds the per-field
// frontmatter problems for files that parsed. A clean file is issues: []
// with no error key at all.
interface LintedFile {
  path: string;
  issues: LintIssue[];
  error?: string;
}

// Shape of "gnt rules lint --json" -- the same numbers the human summary
// line prints, plus per-file detail, so a CI step can consume real data
// instead of scraping colored stdout (see .github/actions/lint-rules).
interface LintReport {
  files: LintedFile[];
  checked: number;
  clean: number;
  with_issues: number;
  ok: boolean;
}

interface ParsedRuleFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

// Mirrors parse_rule_markdown (apps/api/src/gnt/github/render.py) and
// parseRuleFile (apps/store/src/native/sync.ts) -- same fence shape, same
// js-yaml parser, so a file this command calls clean parses identically
// wherever it's actually read.
function parseRuleFile(content: string): ParsedRuleFile | null {
  if (!content.startsWith(FENCE_OPEN)) return null;
  const afterOpen = content.slice(FENCE_OPEN.length);
  const closeIdx = afterOpen.indexOf(FENCE_CLOSE);
  if (closeIdx === -1) return null;
  const yamlBlock = afterOpen.slice(0, closeIdx);
  const body = afterOpen.slice(closeIdx + FENCE_CLOSE.length);
  let loaded: unknown;
  try {
    loaded = load(yamlBlock);
  } catch {
    return null;
  }
  return {
    frontmatter: loaded && typeof loaded === "object" ? (loaded as Record<string, unknown>) : {},
    body: body.replace(/^\n+/, "").replace(/\n+$/, ""),
  };
}

// Same constraints as apps/api's CreateRuleRequest (routers/rules.py) for
// title/body/confidence/tags, plus RuleStatus's five values above -- the
// two places a rule's shape is actually enforced today, server-side, after
// a PR round-trip. This is the same check, run locally instead.
function lintFrontmatter(fm: Record<string, unknown>, body: string): LintIssue[] {
  const issues: LintIssue[] = [];

  if (typeof fm.title !== "string" || fm.title.trim().length === 0) {
    issues.push({ field: "title", message: "must be a non-empty string" });
  } else if (fm.title.length > 200) {
    issues.push({ field: "title", message: `must be <=200 characters (got ${fm.title.length})` });
  }

  if (body.trim().length === 0) {
    issues.push({ field: "body", message: "must be non-empty" });
  } else if (body.length > 8000) {
    issues.push({ field: "body", message: `must be <=8000 characters (got ${body.length})` });
  }

  if ("status" in fm && !RULE_STATUSES.has(String(fm.status))) {
    issues.push({
      field: "status",
      message: `must be one of ${[...RULE_STATUSES].join(", ")} (got ${JSON.stringify(fm.status)})`,
    });
  }

  if ("confidence" in fm) {
    const confidence = fm.confidence;
    if (typeof confidence !== "number" || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
      issues.push({ field: "confidence", message: `must be a number between 0 and 1 (got ${JSON.stringify(confidence)})` });
    }
  }

  if ("owner_id" in fm && (typeof fm.owner_id !== "string" || fm.owner_id.trim().length === 0)) {
    issues.push({ field: "owner_id", message: "must be a non-empty string when present" });
  }

  if ("tags" in fm) {
    const tags = fm.tags;
    if (!Array.isArray(tags)) {
      issues.push({ field: "tags", message: "must be an array of strings" });
    } else {
      if (tags.length > 20) {
        issues.push({ field: "tags", message: `must have <=20 entries (got ${tags.length})` });
      }
      tags.forEach((tag, index) => {
        if (typeof tag !== "string" || tag.trim().length === 0) {
          issues.push({ field: "tags", message: `entry ${index} must be a non-empty string` });
        } else if (tag.length > 64) {
          issues.push({ field: "tags", message: `entry ${index} must be <=64 characters (got ${tag.length})` });
        }
      });
    }
  }

  if ("source_citations" in fm) {
    const citations = fm.source_citations;
    if (!Array.isArray(citations)) {
      issues.push({ field: "source_citations", message: "must be an array when present" });
    } else {
      citations.forEach((citation, index) => {
        if (typeof citation !== "object" || citation === null || Array.isArray(citation)) {
          issues.push({ field: "source_citations", message: `entry ${index} must be an object` });
        }
      });
    }
  }

  if ("source" in fm && fm.source !== null) {
    if (typeof fm.source !== "string") {
      issues.push({ field: "source", message: "must be a string when present" });
    } else if (fm.source.length > 2000) {
      issues.push({ field: "source", message: `must be <=2000 characters (got ${fm.source.length})` });
    }
  }

  if ("version" in fm) {
    const version = fm.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      issues.push({ field: "version", message: `must be a positive integer (got ${JSON.stringify(version)})` });
    }
  }

  return issues;
}

function resolveTargets(target: string): string[] {
  if (!existsSync(target)) return [];
  if (statSync(target).isDirectory()) return collectFiles(target, [".md"]);
  return [target];
}

// gnt rules lint validates a rule file's frontmatter against the same shape
// apps/api's CreateRuleRequest and apps/store's RuleStatus enforce server-side
// today -- so a malformed rule fails locally, before a PR round-trip, instead
// of only surfacing once a maintainer opens the PR (see #97).
//
// Both output modes share the same walk and the same failure accounting; the
// --json branch just renders the accumulated report instead of the colored
// lines. Exit code is identical either way (1 when any file has issues), so
// a CI step gets the same pass/fail signal from the machine-readable path.
export async function rulesLint(inputPath?: string, options: { json?: boolean } = {}): Promise<void> {
  const target = resolve(inputPath ?? "rules");
  const files = resolveTargets(target);

  if (files.length === 0) {
    if (options.json) {
      console.log(JSON.stringify({ files: [], checked: 0, clean: 0, with_issues: 0, ok: true }, null, 2));
      return;
    }
    console.log(muted(`No rule files found at ${target}.`));
    return;
  }

  const report: LintReport = { files: [], checked: 0, clean: 0, with_issues: 0, ok: true };

  for (const filePath of files) {
    const relPath = relative(process.cwd(), filePath);
    const linted: LintedFile = { path: relPath, issues: [] };

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch (err) {
      linted.error = `could not read file (${(err as Error).message})`;
      report.with_issues++;
      report.ok = false;
      if (!options.json) console.log(fail(`${relPath}: ${linted.error}`));
      report.files.push(linted);
      continue;
    }

    const parsed = parseRuleFile(content);
    if (!parsed) {
      linted.error = "missing or malformed frontmatter fence";
      report.with_issues++;
      report.ok = false;
      if (!options.json) console.log(fail(`${relPath}: ${linted.error}`));
      report.files.push(linted);
      continue;
    }

    const issues = lintFrontmatter(parsed.frontmatter, parsed.body);
    linted.issues = issues;
    if (issues.length === 0) {
      report.clean++;
      if (!options.json) console.log(ok(relPath));
    } else {
      report.with_issues++;
      report.ok = false;
      if (!options.json) {
        console.log(fail(relPath));
        for (const issue of issues) {
          console.log(`   ${dim(issue.field)} ${text(issue.message)}`);
        }
      }
    }
    report.files.push(linted);
  }

  report.checked = report.files.length;

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log();
    console.log(bold(`${report.checked} file(s) checked: ${report.clean} clean, ${report.with_issues} with issues.`));
  }

  if (report.with_issues > 0) process.exit(1);
}

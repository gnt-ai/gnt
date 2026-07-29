// Repo-scan walker: walks the repo `gnt prebrain` is run
// inside -- defaults to process.cwd(), which is the whole contract: this
// walker assumes it's invoked from a repo root (or run.ts/the command
// layer resolves an explicit path first), it doesn't go looking for a
// .git directory itself.
//
// Targets exactly what the plan names -- README, CONTRIBUTING, CODEOWNERS,
// PR templates, lint configs, CI configs -- covering the common/obvious
// naming variance, not every possible ecosystem:
//   - README / CONTRIBUTING: *.md, *.mdx, *.txt, or extensionless, matched
//     case-insensitively, anywhere in the tree (a monorepo like this one
//     has more than one). GitLab uses the same root-level CONTRIBUTING.md
//     convention as GitHub, so no separate pattern is needed here.
//   - CODEOWNERS: filename CODEOWNERS (case-insensitive), wherever found.
//     GitHub only honors root, .github/, or docs/; GitLab only honors
//     root, .gitlab/, or docs/ -- this walker doesn't restrict to any of
//     those, it takes whatever the tree has, so both vendors' search
//     paths (including GitLab's .gitlab/CODEOWNERS) are covered without a
//     directory check. Section headers, approval-count, and default-owner
//     syntax inside the file (GitLab's CODEOWNERS dialect adds all three)
//     are content the file's prose chunking already passes through as-is;
//     this walker never parses CODEOWNERS structure for either vendor.
//   - PR templates: .github/pull_request_template.md, a root/.github-level
//     pull_request_template.md, any .md inside a PULL_REQUEST_TEMPLATE/
//     directory (GitHub's multi-template convention), or any .md inside a
//     .gitlab/merge_request_templates/ directory (GitLab's equivalent,
//     including its Default.md convention -- a merge request template is
//     the same kind of proposal-shape content as a pull request template,
//     so it shares this category rather than getting its own).
//   - lint configs: eslint (eslint.config.{js,cjs,mjs,ts}, .eslintrc and
//     its .js/.cjs/.json/.yml/.yaml variants) and ruff (ruff.toml,
//     .ruff.toml) -- the two ecosystems this monorepo itself uses, per the
//     task. NOT covered: ruff config embedded in pyproject.toml (this
//     walker doesn't parse TOML sections out of a file that's mostly not
//     lint config), prettier, stylelint, golangci-lint, rubocop, and every
//     other ecosystem's lint config. Add matchers here as real customer
//     repos need them.
//   - CI configs: .github/workflows/*.yml and *.yaml, and .gitlab-ci.yml
//     (GitLab's default pipeline file, matched case-insensitively wherever
//     found in the tree, same monorepo-friendliness as README/CONTRIBUTING
//     -- a subproject can carry its own). NOT covered: a GitLab project's
//     custom CI config path/filename (a per-project setting, not
//     discoverable from the file tree), CircleCI, Jenkinsfiles, Travis --
//     same "common/obvious, not exhaustive" call as lint configs.
//
// Directory skip list intentionally does NOT include .github or .gitlab
// (PR/MR templates and CI configs live there) or other dotdirs in general
// the way docs-dir.ts's walk does -- a repo root has legitimate targets
// inside dotdirs, a user-pointed docs directory doesn't.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { classifyDecisionProse, chunkText } from "./chunk.js";
import type { PrebrainChunk } from "./types.js";

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "coverage",
  ".cache",
  "venv",
  ".venv",
  "__pycache__",
  "target",
  "vendor",
  ".idea",
  ".vscode",
]);

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DEPTH = 8;

const README_PATTERN = /^readme(\.(md|mdx|txt))?$/;
const CONTRIBUTING_PATTERN = /^contributing(\.(md|mdx|txt))?$/;
const ESLINTRC_PATTERN = /^\.eslintrc(\.(js|cjs|json|yml|yaml))?$/;
const ESLINT_FLAT_CONFIG_PATTERN = /^eslint\.config\.(js|cjs|mjs|ts)$/;
const GITLAB_CI_PATTERN = /^\.gitlab-ci\.ya?ml$/;

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

// One category per target the plan names -- not part of PrebrainChunk
// itself (see types.ts), this only drives which files get read and, later,
// the command's per-source summary counts.
export type RepoScanCategory = "readme" | "contributing" | "codeowners" | "pr-template" | "lint-config" | "ci-config";

// Exported so the command layer can bucket a repo-scan summary by category
// ("2 readme, 1 ci-config, ...") without re-deriving the same rules.
export function classifyRepoScanTarget(relPath: string): RepoScanCategory | null {
  const posixPath = toPosix(relPath);
  const base = basename(posixPath).toLowerCase();
  const dir = toPosix(dirname(posixPath)).toLowerCase();

  if (README_PATTERN.test(base)) return "readme";
  if (CONTRIBUTING_PATTERN.test(base)) return "contributing";
  if (base === "codeowners") return "codeowners";
  if (base === "pull_request_template.md") return "pr-template";
  if ((dir === ".github/pull_request_template" || dir.endsWith("/pull_request_template")) && base.endsWith(".md")) {
    return "pr-template";
  }
  if (
    (dir === ".gitlab/merge_request_templates" || dir.endsWith("/.gitlab/merge_request_templates")) &&
    base.endsWith(".md")
  ) {
    return "pr-template";
  }
  if (ESLINTRC_PATTERN.test(base) || ESLINT_FLAT_CONFIG_PATTERN.test(base)) return "lint-config";
  if (base === "ruff.toml" || base === ".ruff.toml") return "lint-config";
  if ((dir === ".github/workflows" || dir.endsWith("/.github/workflows")) && /\.(yml|yaml)$/.test(base)) {
    return "ci-config";
  }
  if (GITLAB_CI_PATTERN.test(base)) return "ci-config";
  return null;
}

function collectTargetFiles(root: string): string[] {
  const results: string[] = [];

  function walk(dir: string, depth: number) {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const relPath = relative(root, fullPath);
        if (classifyRepoScanTarget(relPath) !== null) results.push(fullPath);
      }
    }
  }

  walk(root, 0);
  return results;
}

export async function walkRepoScan(root: string = process.cwd()): Promise<PrebrainChunk[]> {
  const files = collectTargetFiles(root);
  const chunks: PrebrainChunk[] = [];

  for (const filePath of files) {
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const sourcePath = toPosix(relative(root, filePath));
    for (const chunk of chunkText(content)) {
      chunks.push({
        text: chunk.text,
        sourcePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        walker: "repo-scan",
        looksLikeDecisionProse: classifyDecisionProse(chunk.text),
      });
    }
  }

  return chunks;
}

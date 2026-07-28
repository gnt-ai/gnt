// Tests the repo-scan walker against a real, on-disk fixture repo (same
// "build real fixtures, don't mock fs" approach as
// test/privacy-gate/redaction-report.test.ts's writeRedactionReport
// coverage) -- covers the happy path across every target category, real
// naming variance (README vs readme.md), and skipping node_modules noise.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyRepoScanTarget, walkRepoScan } from "../../src/prebrain/repo-scan.js";

let repoRoot: string;

function write(relPath: string, content: string) {
  const fullPath = join(repoRoot, relPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content);
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "gnt-prebrain-repo-scan-"));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

test("finds a README (case/extension variance), CONTRIBUTING, CODEOWNERS, PR template, lint config, and CI config", async () => {
  write("README.md", "# gnt.ai\n\nRefunds over 15% require manager sign-off.\n");
  write("CONTRIBUTING.md", "## How to contribute\n\nAll changes must go through review before merging.\n");
  write("CODEOWNERS", "* @lukaadzic\n");
  write(".github/pull_request_template.md", "## What & why\n\nDescribe why this change is needed.\n");
  write(".github/workflows/ci.yml", "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n");
  write(
    ".eslintrc.json",
    JSON.stringify({ rules: { "no-unused-vars": "error" } }, null, 2),
  );
  write("ruff.toml", "line-length = 100\n[lint]\nselect = [\"E\", \"F\"]\n");

  const chunks = await walkRepoScan(repoRoot);
  const sourcePaths = new Set(chunks.map((c) => c.sourcePath));

  expect(sourcePaths).toContain("README.md");
  expect(sourcePaths).toContain("CONTRIBUTING.md");
  expect(sourcePaths).toContain("CODEOWNERS");
  expect(sourcePaths).toContain(".github/pull_request_template.md");
  expect(sourcePaths).toContain(".github/workflows/ci.yml");
  expect(sourcePaths).toContain(".eslintrc.json");
  expect(sourcePaths).toContain("ruff.toml");

  for (const chunk of chunks) {
    expect(chunk.walker).toBe("repo-scan");
  }

  expect(classifyRepoScanTarget("README.md")).toBe("readme");
  expect(classifyRepoScanTarget("readme")).toBe("readme");
  expect(classifyRepoScanTarget("CONTRIBUTING.md")).toBe("contributing");
  expect(classifyRepoScanTarget("CODEOWNERS")).toBe("codeowners");
  expect(classifyRepoScanTarget(".github/pull_request_template.md")).toBe("pr-template");
  expect(classifyRepoScanTarget(".github/PULL_REQUEST_TEMPLATE/bugfix.md")).toBe("pr-template");
  expect(classifyRepoScanTarget(".eslintrc.json")).toBe("lint-config");
  expect(classifyRepoScanTarget("eslint.config.js")).toBe("lint-config");
  expect(classifyRepoScanTarget("ruff.toml")).toBe("lint-config");
  expect(classifyRepoScanTarget(".github/workflows/ci.yml")).toBe("ci-config");
});

test("finds GitLab-flavored conventions: alternate CODEOWNERS locations, .gitlab-ci.yml, and an MR template directory", async () => {
  write("docs/CODEOWNERS", "[Backend]\n*.go @backend-team\n");
  write(".gitlab/CODEOWNERS", "^[Optional docs]\n*.md @docs-team\n");
  write(".gitlab-ci.yml", "stages:\n  - test\ntest:\n  stage: test\n  script:\n    - echo test\n");
  write(".gitlab/merge_request_templates/Default.md", "## What does this MR do?\n\nDescribe the change and why it's needed.\n");
  write(".gitlab/merge_request_templates/bugfix.md", "## Bug\n\nWhat broke and how this fixes it.\n");

  const chunks = await walkRepoScan(repoRoot);
  const sourcePaths = new Set(chunks.map((c) => c.sourcePath));

  expect(sourcePaths).toContain("docs/CODEOWNERS");
  expect(sourcePaths).toContain(".gitlab/CODEOWNERS");
  expect(sourcePaths).toContain(".gitlab-ci.yml");
  expect(sourcePaths).toContain(".gitlab/merge_request_templates/Default.md");
  expect(sourcePaths).toContain(".gitlab/merge_request_templates/bugfix.md");

  for (const chunk of chunks) {
    expect(chunk.walker).toBe("repo-scan");
  }

  expect(classifyRepoScanTarget("docs/CODEOWNERS")).toBe("codeowners");
  expect(classifyRepoScanTarget(".gitlab/CODEOWNERS")).toBe("codeowners");
  expect(classifyRepoScanTarget(".gitlab-ci.yml")).toBe("ci-config");
  expect(classifyRepoScanTarget(".GITLAB-CI.YML")).toBe("ci-config");
  expect(classifyRepoScanTarget(".gitlab/merge_request_templates/Default.md")).toBe("pr-template");
  expect(classifyRepoScanTarget(".gitlab/merge_request_templates/bugfix.md")).toBe("pr-template");
});

test("GitLab CONTRIBUTING.md uses the same root-level convention already covered by the README/CONTRIBUTING pattern", () => {
  expect(classifyRepoScanTarget("CONTRIBUTING.md")).toBe("contributing");
});

test("nested .gitlab-ci.yml and MR templates are recognized per-package, matching the monorepo README behavior", async () => {
  write("apps/cli/.gitlab-ci.yml", "stages:\n  - build\n");
  write("apps/cli/.gitlab/merge_request_templates/Default.md", "## Package-level MR template\n");

  const chunks = await walkRepoScan(repoRoot);
  const sourcePaths = new Set(chunks.map((c) => c.sourcePath));

  expect(sourcePaths).toContain("apps/cli/.gitlab-ci.yml");
  expect(sourcePaths).toContain("apps/cli/.gitlab/merge_request_templates/Default.md");
});

test("does not misclassify a .gitlab-ci.yml lookalike or a stray file inside a differently-named templates dir", () => {
  expect(classifyRepoScanTarget("not-gitlab-ci.yml")).toBeNull();
  expect(classifyRepoScanTarget(".gitlab/merge_request_template/bugfix.md")).toBeNull();
  expect(classifyRepoScanTarget(".gitlab/merge_request_templates/notes.txt")).toBeNull();
});

test("matches README/CONTRIBUTING naming variance case-insensitively and extensionlessly", () => {
  expect(classifyRepoScanTarget("readme.md")).toBe("readme");
  expect(classifyRepoScanTarget("Readme.md")).toBe("readme");
  expect(classifyRepoScanTarget("apps/cli/README.md")).toBe("readme");
  expect(classifyRepoScanTarget("contributing")).toBe("contributing");
  expect(classifyRepoScanTarget("CONTRIBUTING.txt")).toBe("contributing");
});

test("finds README files nested across a monorepo, one chunk set per package", async () => {
  write("README.md", "Root readme content that is not boilerplate at all here.\n");
  write("apps/cli/README.md", "CLI package readme content that is not boilerplate at all here.\n");

  const chunks = await walkRepoScan(repoRoot);
  const sourcePaths = new Set(chunks.map((c) => c.sourcePath));

  expect(sourcePaths).toContain("README.md");
  expect(sourcePaths).toContain("apps/cli/README.md");
});

test("skips node_modules and other build/dependency noise", async () => {
  write("node_modules/some-lib/README.md", "Should never be walked.\n");
  write("dist/README.md", "Should never be walked.\n");
  write("README.md", "The only README that should be found.\n");

  const chunks = await walkRepoScan(repoRoot);
  const sourcePaths = chunks.map((c) => c.sourcePath);

  expect(sourcePaths).toEqual(["README.md"]);
});

test("does not pick up unrelated source files", async () => {
  write("src/index.ts", "export const x = 1;\n");
  write("package.json", JSON.stringify({ name: "fixture" }));

  const chunks = await walkRepoScan(repoRoot);

  expect(chunks).toHaveLength(0);
});

test("an empty/nonexistent repo root produces no chunks", async () => {
  const chunks = await walkRepoScan(join(repoRoot, "does-not-exist"));
  expect(chunks).toHaveLength(0);
});

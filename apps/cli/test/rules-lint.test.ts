import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rulesLint } from "../src/commands/rules-lint.js";

let testDir: string;
let logs: string[];
let originalLog: typeof console.log;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "gnt-rules-lint-test-"));
  logs = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
  rmSync(testDir, { recursive: true, force: true });
});

function stubExit() {
  const originalExit = process.exit;
  const exitCalls: number[] = [];
  // @ts-expect-error -- stubbing process.exit for the test
  process.exit = (code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error("process.exit called");
  };
  return {
    exitCalls,
    restore: () => {
      process.exit = originalExit;
    },
  };
}

const VALID_RULE = `---
title: Never refund over $500 without a manager
status: approved
confidence: 0.91
owner_id: finance-team
source_citations: []
source: slack
tags: [refunds, finance]
last_validated_at: 2026-07-20
version: 1
superseded_by: null
approved_by: jane@company.com
approved_at: 2026-07-21T14:03:00Z
created_at: 2026-07-18T09:12:00Z
pr_number: 142
pr_url: https://github.com/your-org/your-repo/pull/142
---

Refunds over $500 need manager sign-off before they go out.
`;

test("reports no rule files found for an empty/missing directory", async () => {
  await rulesLint(join(testDir, "nope"));
  expect(logs.join("\n")).toContain("No rule files found");
});

test("passes a well-formed rule file", async () => {
  writeFileSync(join(testDir, "refund.md"), VALID_RULE);

  await rulesLint(testDir);

  const output = logs.join("\n");
  expect(output).toContain("refund.md");
  expect(output).toContain("1 clean, 0 with issues");
});

test("flags a missing frontmatter fence", async () => {
  writeFileSync(join(testDir, "broken.md"), "no frontmatter here\n");
  const { exitCalls, restore } = stubExit();

  try {
    await expect(rulesLint(testDir)).rejects.toThrow("process.exit called");
  } finally {
    restore();
  }

  expect(exitCalls).toEqual([1]);
  expect(logs.join("\n")).toContain("missing or malformed frontmatter fence");
});

test("flags an empty title, an out-of-range confidence, and an invalid status", async () => {
  const bad = `---
title: ""
status: bogus
confidence: 1.5
---

Some body text.
`;
  writeFileSync(join(testDir, "bad.md"), bad);
  const { exitCalls, restore } = stubExit();

  try {
    await expect(rulesLint(testDir)).rejects.toThrow("process.exit called");
  } finally {
    restore();
  }

  expect(exitCalls).toEqual([1]);
  const output = logs.join("\n");
  expect(output).toContain("title");
  expect(output).toContain("must be a non-empty string");
  expect(output).toContain("status");
  expect(output).toContain("must be one of draft, in_review, pending_merge, approved, deprecated");
  expect(output).toContain("confidence");
  expect(output).toContain("must be a number between 0 and 1");
});

test("flags an oversized tags array and an overlong tag", async () => {
  const tooManyTags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
  const bad = `---
title: Some rule
tags: [${tooManyTags.map((t) => JSON.stringify(t)).join(", ")}]
---

Body.
`;
  writeFileSync(join(testDir, "tags.md"), bad);
  const { exitCalls, restore } = stubExit();

  try {
    await expect(rulesLint(testDir)).rejects.toThrow("process.exit called");
  } finally {
    restore();
  }

  expect(exitCalls).toEqual([1]);
  expect(logs.join("\n")).toContain("must have <=20 entries");
});

test("flags a non-object source_citations entry and an overlong source", async () => {
  const bad = `---
title: Some rule
source_citations: [42]
source: ${"x".repeat(2001)}
---

Body.
`;
  writeFileSync(join(testDir, "provenance.md"), bad);
  const { exitCalls, restore } = stubExit();

  try {
    await expect(rulesLint(testDir)).rejects.toThrow("process.exit called");
  } finally {
    restore();
  }

  expect(exitCalls).toEqual([1]);
  const output = logs.join("\n");
  expect(output).toContain("source_citations");
  expect(output).toContain("entry 0 must be an object");
  expect(output).toContain("source");
  expect(output).toContain("must be <=2000 characters");
});

test("lints a single file passed directly, not just a directory", async () => {
  const filePath = join(testDir, "refund.md");
  writeFileSync(filePath, VALID_RULE);

  await rulesLint(filePath);

  expect(logs.join("\n")).toContain("1 clean, 0 with issues");
});

test("--json prints an empty report when no rule files exist", async () => {
  await rulesLint(join(testDir, "nope"), { json: true });

  expect(JSON.parse(logs.join("\n"))).toEqual({
    files: [],
    checked: 0,
    clean: 0,
    with_issues: 0,
    ok: true,
  });
});

test("--json reports a clean pass with per-file detail", async () => {
  writeFileSync(join(testDir, "refund.md"), VALID_RULE);

  await rulesLint(testDir, { json: true });

  const report = JSON.parse(logs.join("\n"));
  expect(report.ok).toBe(true);
  expect(report.checked).toBe(1);
  expect(report.clean).toBe(1);
  expect(report.with_issues).toBe(0);
  expect(report.files).toHaveLength(1);
  expect(report.files[0].path).toContain("refund.md");
  expect(report.files[0].issues).toEqual([]);
  // A clean file carries no error key at all, not an empty string.
  expect("error" in report.files[0]).toBe(false);
});

test("--json lists frontmatter issues per file and keeps the exit code", async () => {
  const bad = `---
title: ""
status: bogus
confidence: 1.5
---

Some body text.
`;
  writeFileSync(join(testDir, "bad.md"), bad);
  const { exitCalls, restore } = stubExit();

  try {
    await expect(rulesLint(testDir, { json: true })).rejects.toThrow("process.exit called");
  } finally {
    restore();
  }

  expect(exitCalls).toEqual([1]);
  const report = JSON.parse(logs.join("\n"));
  expect(report.ok).toBe(false);
  expect(report.checked).toBe(1);
  expect(report.clean).toBe(0);
  expect(report.with_issues).toBe(1);
  expect(report.files[0].issues).toEqual(
    expect.arrayContaining([
      { field: "title", message: "must be a non-empty string" },
      { field: "status", message: "must be one of draft, in_review, pending_merge, approved, deprecated (got \"bogus\")" },
      { field: "confidence", message: "must be a number between 0 and 1 (got 1.5)" },
    ]),
  );
});

test("--json reports a malformed frontmatter fence as a file-level error", async () => {
  writeFileSync(join(testDir, "broken.md"), "no frontmatter here\n");
  const { exitCalls, restore } = stubExit();

  try {
    await expect(rulesLint(testDir, { json: true })).rejects.toThrow("process.exit called");
  } finally {
    restore();
  }

  expect(exitCalls).toEqual([1]);
  const report = JSON.parse(logs.join("\n"));
  expect(report.ok).toBe(false);
  expect(report.files[0].error).toContain("missing or malformed frontmatter fence");
  expect(report.files[0].issues).toEqual([]);
});

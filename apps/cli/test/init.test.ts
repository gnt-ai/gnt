import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/commands/init.js";

let scratchDir: string;
let logs: string[];
let originalLog: typeof console.log;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "gnt-init-test-"));
  logs = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
  rmSync(scratchDir, { recursive: true, force: true });
});

test("scaffolds rules/ with example rule files", () => {
  init({ dir: scratchDir });

  const refund = readFileSync(join(scratchDir, "rules", "refund-approval-threshold.md"), "utf-8");
  expect(refund).toStartWith("---\n");
  expect(refund).toContain("title: Refund approval threshold");
  expect(refund).toContain("status: draft");
  expect(refund).toContain("approved_by: null");

  const legal = readFileSync(join(scratchDir, "rules", "contract-legal-cc.md"), "utf-8");
  expect(legal).toContain("title: CC legal on contract mentions");

  const output = logs.join("\n");
  expect(output).toContain("Scaffolded 2 example rules");
  expect(output).toContain("gnt prebrain --starter-packs");
});

test("never overwrites a file that's already there", () => {
  init({ dir: scratchDir });
  writeFileSync(join(scratchDir, "rules", "refund-approval-threshold.md"), "edited by hand\n");

  init({ dir: scratchDir });

  const content = readFileSync(join(scratchDir, "rules", "refund-approval-threshold.md"), "utf-8");
  expect(content).toBe("edited by hand\n");
  const output = logs.join("\n");
  expect(output).toContain("Already exists, left untouched: rules/refund-approval-threshold.md");
});

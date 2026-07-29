// Tests the starter-pack data module itself: packs.jsonl
// loads and every rule in it has the required fields and reads as an
// editable starting point, not a stated fact -- plus resolveStarterPacks'
// "all"/comma-list/unknown-id parsing. See ../prebrain-pipeline.test.ts for
// this module wired into the real `gnt prebrain` command.
import { expect, test } from "bun:test";
import { listStarterPackIds, loadAllStarterPackRules, resolveStarterPacks } from "../../src/prebrain/starter-packs/index.js";

// Same heuristic assertGenericFraming enforces at load time, kept
// independent here rather than importing it (this test guards against a
// silent regression to that heuristic itself, not just against
// packs.jsonl drifting).
const HEDGE_MARKERS = [/\btypically\b/i, /\badjust\b/i, /\bedit this\b/i, /\byour (own )?/i, /\bstarting point\b/i, /\bcustomize\b/i, /\bverify\b/i];

test("packs.jsonl loads and every rule has the required fields", () => {
  const rules = loadAllStarterPackRules();

  expect(rules.length).toBeGreaterThan(0);
  for (const rule of rules) {
    expect(typeof rule.pack).toBe("string");
    expect(rule.pack.length).toBeGreaterThan(0);
    expect(typeof rule.title).toBe("string");
    expect(rule.title.length).toBeGreaterThan(0);
    expect(typeof rule.body).toBe("string");
    expect(rule.body.length).toBeGreaterThan(0);
    expect(Array.isArray(rule.tags)).toBe(true);
    expect(rule.tags.length).toBeGreaterThan(0);
  }
});

test("every starter rule's body reads as an editable starting point, not a stated fact", () => {
  const rules = loadAllStarterPackRules();

  for (const rule of rules) {
    const hasHedge = HEDGE_MARKERS.some((marker) => marker.test(rule.body));
    expect(hasHedge).toBe(true);
  }
});

test("covers real breadth beyond the plan's own 4 named topics, per the founder's scope call", () => {
  const ids = listStarterPackIds();

  // The plan names refunds/escalation, discount approvals, engineering
  // conventions, and incident response explicitly -- the founder's own
  // scope call (2026-07-18) asked for genuine breadth beyond those 4, not
  // a padded list. This asserts both: the named 4 are present, and there
  // are more than 4 packs total.
  expect(ids).toContain("refunds-escalation");
  expect(ids).toContain("discount-pricing-approval");
  expect(ids).toContain("engineering-conventions");
  expect(ids).toContain("incident-response");
  expect(ids.length).toBeGreaterThan(4);
});

test("each rule's first tag matches its own pack id, so real batching buckets by pack", () => {
  // groupByTopic (commands/prebrain.ts) buckets by a rule's first tag --
  // this keeps starter-pack rules from the same pack landing in the same
  // batch without any special-casing in the batching logic itself.
  for (const rule of loadAllStarterPackRules()) {
    expect(rule.tags[0]).toBe(rule.pack);
  }
});

test("resolveStarterPacks(\"all\") returns every pack's rules", () => {
  const selection = resolveStarterPacks("all");
  const allIds = listStarterPackIds();

  expect(selection.packIds.sort()).toEqual(allIds);
  expect(selection.invalidIds).toEqual([]);
  expect(selection.rules.length).toBe(loadAllStarterPackRules().length);
});

test("resolveStarterPacks parses a comma-separated list of specific pack ids", () => {
  const selection = resolveStarterPacks("incident-response, expense-approval");

  expect(selection.packIds.sort()).toEqual(["expense-approval", "incident-response"]);
  expect(selection.invalidIds).toEqual([]);
  expect(selection.rules.every((rule) => rule.tags[0] === "incident-response" || rule.tags[0] === "expense-approval")).toBe(true);
});

test("resolveStarterPacks reports unknown pack ids without dropping the valid ones", () => {
  const selection = resolveStarterPacks("incident-response,not-a-real-pack");

  expect(selection.packIds).toEqual(["incident-response"]);
  expect(selection.invalidIds).toEqual(["not-a-real-pack"]);
  expect(selection.rules.length).toBeGreaterThan(0);
});

test("every starter-pack rule's source string identifies it as generic gnt.ai content, not something found locally", () => {
  const selection = resolveStarterPacks("all");

  for (const rule of selection.rules) {
    expect(rule.source).toMatch(/^gnt\.ai starter pack: /);
    // Never a local file path/line-span the way real extraction's source
    // strings are (e.g. "README.md:42-58") -- there's no local file
    // behind a starter-pack rule to cite.
    expect(rule.source).not.toMatch(/:\d/);
    expect(rule.sourceCitations).toEqual([]);
  }
});

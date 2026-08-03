import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneDirFor, normalizeSourceId } from "../src/core/source-paths.ts";

/** Direct coverage for the org-id → storage source-id mapping every adapter
 * shares. A silent drift here orphans existing rows on adapter cutover; the
 * engine's own validator also rejects raw Better Auth org ids on case/length,
 * so the shape of this output is load-bearing. */

describe("normalizeSourceId", () => {
  test("is deterministic for the same org id", () => {
    const a = normalizeSourceId("org_AbC123");
    const b = normalizeSourceId("org_AbC123");
    expect(a).toBe(b);
  });

  test("different org ids produce different normalized ids", () => {
    expect(normalizeSourceId("org-one")).not.toBe(normalizeSourceId("org-two"));
  });

  test("always matches org- + 28 lowercase hex chars (exactly 32 total)", () => {
    const cases = [
      "simple",
      "MixedCaseOrgId",
      "org_with_underscores",
      "a".repeat(64),
      "",
    ];
    for (const orgId of cases) {
      const id = normalizeSourceId(orgId);
      expect(id).toMatch(/^org-[0-9a-f]{28}$/);
      expect(id).toHaveLength(32);
      expect(id.startsWith("org-")).toBe(true);
    }
  });

  test("different casing of the same characters produces different source ids", () => {
    // Hash is over the raw bytes — no case folding — so callers must not treat
    // "Abc" and "abc" as interchangeable org ids.
    expect(normalizeSourceId("Abc")).not.toBe(normalizeSourceId("abc"));
  });

  test("matches a hardcoded golden sha256 slice mapping", () => {
    // Golden: printf '%s' 'better-auth-style-id' | shasum -a 256 | cut -c1-28
    // Hardcoded so a hash/prefix/slice change fails independently of this file.
    expect(normalizeSourceId("better-auth-style-id")).toBe(
      "org-f261f82fd67403939b29e499e8fb",
    );
  });
});

describe("cloneDirFor", () => {
  const previous = process.env.GNT_STORE_CLONES_DIR;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.GNT_STORE_CLONES_DIR;
    } else {
      process.env.GNT_STORE_CLONES_DIR = previous;
    }
  });

  test("joins sourceId onto GNT_STORE_CLONES_DIR when set", () => {
    process.env.GNT_STORE_CLONES_DIR = "/var/gnt/clones";
    expect(cloneDirFor("org-abc")).toBe(join("/var/gnt/clones", "org-abc"));
  });

  test("falls back to tmpdir/gnt-store-clones when the env var is unset", () => {
    delete process.env.GNT_STORE_CLONES_DIR;
    expect(cloneDirFor("org-abc")).toBe(join(tmpdir(), "gnt-store-clones", "org-abc"));
  });
});

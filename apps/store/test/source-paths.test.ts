import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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

  test("case-folds via hashing — mixed-case input still yields lowercase hex", () => {
    const id = normalizeSourceId("OrgID_With_UPPER");
    expect(id).toBe(id.toLowerCase());
    expect(id).toMatch(/^org-[0-9a-f]{28}$/);
  });

  test("matches the documented sha256 slice mapping", () => {
    const orgId = "better-auth-style-id";
    const expected =
      "org-" + createHash("sha256").update(orgId).digest("hex").slice(0, 28);
    expect(normalizeSourceId(orgId)).toBe(expected);
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

/**
 * Shared by every storage adapter (engine-backed, native) — the mapping
 * from an org id to a storage-layer source id, and from a source id to its
 * on-disk clone directory, MUST produce identical output regardless of
 * which adapter is live. Both read/write the same underlying tables keyed
 * on this id; a divergent implementation between adapters would silently
 * orphan an org's existing rows behind a different id on cutover.
 */
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The engine's own source-id validator requires 1-32 lowercase alphanumeric
 * chars with optional interior hyphens (see the vendored engine's
 * sources-ops.ts::validateSourceId) — no underscores, no uppercase, no
 * length past 32. Real org ids (Better Auth's default id generator:
 * mixed-case alphanumeric, no prefix — see apps/web/lib/auth.ts) fail on
 * case alone. This is the ONE mapping from an org id to a storage source
 * id — every sourceId param in every adapter goes through this, never the
 * raw orgId, so a caller can never accidentally bypass it. The RulePage's
 * own `org` field still stores the real, human-readable org id (in
 * frontmatter) — only the internal source-id parameter storage sees is
 * normalized.
 */
export function normalizeSourceId(orgId: string): string {
  const hash = createHash("sha256").update(orgId).digest("hex").slice(0, 28);
  return `org-${hash}`;
}

/** Where an org's cloned rules repo lives on disk. A real deployment should
 * point GNT_STORE_CLONES_DIR at a persistent volume — the default is fine
 * functionally either way (a missing clone just gets re-cloned on the next
 * sync), just wasteful if it happens on every restart. */
export function cloneDirFor(sourceId: string): string {
  const base = process.env.GNT_STORE_CLONES_DIR ?? join(tmpdir(), "gnt-store-clones");
  return join(base, sourceId);
}

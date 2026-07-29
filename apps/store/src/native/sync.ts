/**
 * Native git-native sync for a cloned rules repo — scoped to exactly what
 * gnt itself writes: one file per rule at `rules/<uuid>.md`, YAML
 * frontmatter fence, flat directory (see
 * apps/api/src/gnt/github/render.py::render_rule_markdown, the only writer
 * of this format, and apps/api/src/gnt/routers/rules.py's `_slug`/`_bare_id`
 * for the `rules/<uuid>` slug shape). Not the vendored engine's
 * every-markdown-flavor importer — gnt never writes nested dirs, other
 * extensions, or non-rule page types into a connected repo, so walking the
 * whole tree / running the engine's ~15-extension classifier / schema-pack
 * type inference would all be solving a problem that doesn't exist here.
 *
 * Divergences from the vendored engine's real git-native sync (each is a
 * deliberate scope call, not an oversight — flagged because the cutover
 * task's hard requirement is that re-syncing an existing slug UPDATES that
 * row, not that every column matches byte-for-byte):
 *
 *  - type: every synced page is stamped type="rule" directly, no
 *    path-prefix-based type inference at all — this repo only ever syncs
 *    one page type from one directory (`rules/`), so a general-purpose
 *    inference mechanism would be solving a problem that doesn't exist
 *    here. Self-heals any existing row of the same slug.
 *  - row shape: reuses this store's OWN write convention
 *    (upsertRulePageRow — org/title/body duplicated into frontmatter,
 *    compiled_truth = title+body) for synced rows too, rather than the
 *    engine's separate "strip title/tags out of frontmatter, promote to
 *    page columns / a tags table" convention. NativeStore#rowToRule's
 *    frontmatter-first-then-fallback read path already reconciles both
 *    shapes, so a page looks identical whether it arrived via a direct API
 *    write or a git sync, and tags never need a second table.
 *  - approval signing: bypasses putPage's approvalSignature gate (calls
 *    upsertRulePageRow directly, not putPage). A synced file's frontmatter
 *    is read from a git ref this org's own connected default branch — the
 *    merge itself is the approval event; there is no client-submitted
 *    write to authenticate here. Matches the engine's real import path,
 *    which never threads an approval signature through its importer either.
 *  - content_hash: sha256 of the raw file bytes, not the engine's
 *    field-by-field JSON hash (title/type/compiled_truth/frontmatter-minus-
 *    ephemeral-keys/sorted tags). A row the OLD engine-backed sync already
 *    wrote carries a hash from that different algorithm, so the first
 *    native sync after cutover re-embeds every existing row once — a
 *    one-time cost, not a correctness gap; every sync after that compares
 *    hash-to-hash consistently.
 *  - deletes: hard DELETE FROM pages, matching the engine's own deletePage
 *    exactly (cascades to content_chunks/tags/timeline_entries via the same
 *    ON DELETE CASCADE FKs) — not a soft delete.
 *  - renames: git diff's `R` rows are split into a delete-old + add-new
 *    pair rather than a dedicated rename path — gnt's own writer never
 *    renames a rule file (ids are uuid4, permanent once merged), so a
 *    third code path for a case that can't occur here would be unexercised
 *    complexity.
 *  - slug derivation: ASCII-only (lowercase, strip to [a-z0-9._-], collapse
 *    hyphens) — no CJK preservation the way the engine's slugifySegment
 *    has. gnt's own rule ids are always uuid4() strings, so this is a safe
 *    scope-down, not a behavior change for any file gnt could ever write.
 */

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { load } from "js-yaml";
import { upsertRulePageRow, type EmbedFn, type PgSql } from "./store.ts";
import { toVectorLiteral } from "./search.ts";

const execFile = promisify(execFileCb);
const GIT_TIMEOUT_MS = 30_000;
const RULES_DIR = "rules";
const FENCE_OPEN = "---\n";
const FENCE_CLOSE = "\n---\n";

export interface NativeSyncResult {
  status: "up_to_date" | "synced" | "first_sync";
  fromCommit: string | null;
  toCommit: string;
  added: number;
  modified: number;
  deleted: number;
  embedded: number;
  pagesAffected: string[];
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repoPath, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout.trim();
}

interface RawManifest {
  added: string[];
  modified: string[];
  deleted: string[];
}

/** Only rules/*.md|*.mdx paths make it into the manifest — everything else
 * a diff might mention (a repo's README, CI config, whatever else lives
 * outside rules/) is gnt's business to ignore, not import. */
function pushIfRulePath(bucket: string[], path: string | undefined): void {
  if (path && path.startsWith(`${RULES_DIR}/`) && (path.endsWith(".md") || path.endsWith(".mdx"))) {
    bucket.push(path);
  }
}

/** Diffs two commits and returns the rules/*.md paths that changed, or
 * null when the diff itself is unavailable (the bookmarked commit was
 * gc'd/rewritten) — the caller falls back to a full walk, same fail-open
 * shape as the engine's own computeSyncDelta ladder. */
async function diffRuleFiles(repoPath: string, fromCommit: string, toCommit: string): Promise<RawManifest | null> {
  let raw: string;
  try {
    raw = await git(repoPath, ["diff", "--name-status", "-M", `${fromCommit}..${toCommit}`]);
  } catch {
    return null;
  }
  const manifest: RawManifest = { added: [], modified: [], deleted: [] };
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const action = parts[0];
    if (action === "A") pushIfRulePath(manifest.added, parts[1]);
    else if (action === "M") pushIfRulePath(manifest.modified, parts[1]);
    else if (action === "D") pushIfRulePath(manifest.deleted, parts[1]);
    else if (action.startsWith("R")) {
      // Rename -> delete-old + add-new (see header comment).
      pushIfRulePath(manifest.deleted, parts[1]);
      pushIfRulePath(manifest.added, parts[2]);
    }
  }
  return manifest;
}

/** Every rules/*.md|*.mdx file currently on disk — used for the first sync
 * (no bookmark yet) and as the diff-unavailable fallback. Flat directory
 * only, matching gnt's own writer (see header comment). */
function listRuleFilesOnDisk(repoPath: string): string[] {
  const dir = join(repoPath, RULES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && (e.name.endsWith(".md") || e.name.endsWith(".mdx")))
    .map((e) => `${RULES_DIR}/${e.name}`);
}

function slugifySegment(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/[^a-z0-9._\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Mirrors the engine's pathToSlug(path, {pageKind:'markdown'}) for the
 * ASCII path shapes gnt itself ever writes — see header comment. */
function slugForRulePath(relPath: string): string {
  const withoutExt = relPath.replace(/\.mdx?$/i, "");
  return withoutExt.split("/").map(slugifySegment).filter(Boolean).join("/").toLowerCase();
}

function inferTitleFromFilename(relPath: string): string {
  const base = relPath.split("/").pop()?.replace(/\.mdx?$/i, "") ?? "untitled";
  return base.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface ParsedRuleFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Inverse of render_rule_markdown (apps/api/src/gnt/github/render.py) —
 * same fence shape, parsed with js-yaml (already a direct dependency; see
 * package.json) instead of gray-matter, which isn't one. */
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

function contentHashOf(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Imports one rules/*.md file. Returns true iff it wrote a row (new or
 * changed content); false when the file is unreadable/malformed (skipped,
 * logged, next sync retries) or unchanged since the last sync (no re-embed
 * — the idempotency requirement).
 */
async function importOneFile(
  sql: PgSql,
  embed: EmbedFn,
  ctx: { orgId: string; sourceId: string; repoPath: string; relPath: string },
): Promise<boolean> {
  const { orgId, sourceId, repoPath, relPath } = ctx;
  let raw: string;
  try {
    raw = readFileSync(join(repoPath, relPath), "utf-8");
  } catch {
    // Listed in the diff but gone by the time we read it (rare local race
    // between the diff and the read) — the delete side of a future sync
    // catches it; nothing to import right now.
    return false;
  }
  const parsed = parseRuleFile(raw);
  if (!parsed) {
    console.error(`[native-sync] ${relPath}: missing/malformed frontmatter fence, skipping`);
    return false;
  }

  const hash = contentHashOf(raw);
  const slug = slugForRulePath(relPath);

  const existing = await sql<{ content_hash: string | null }[]>`
    SELECT content_hash FROM pages WHERE source_id = ${sourceId} AND slug = ${slug} AND deleted_at IS NULL LIMIT 1
  `;
  if (existing.length > 0 && existing[0].content_hash === hash) return false;

  const fm = parsed.frontmatter;
  const fullTitle = typeof fm.title === "string" && fm.title ? fm.title : inferTitleFromFilename(relPath);
  const dbTitle = fullTitle.slice(0, 80) || slug;
  const compiledTruth = `${fullTitle}\n\n${parsed.body}`;
  const frontmatter = {
    org: orgId,
    title: fullTitle,
    body: parsed.body,
    status: fm.status ?? "draft",
    confidence: Number(fm.confidence ?? 0),
    owner_id: fm.owner_id ?? "",
    source_citations: fm.source_citations ?? [],
    source: fm.source ?? null,
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    last_validated_at: fm.last_validated_at ?? null,
    version: Number(fm.version ?? 1),
    superseded_by: fm.superseded_by ?? null,
    previous_version_id: fm.previous_version_id ?? null,
    approved_by: fm.approved_by ?? null,
    approved_at: fm.approved_at ?? null,
    created_at: fm.created_at ?? new Date().toISOString(),
    pr_number: fm.pr_number ?? null,
    pr_url: fm.pr_url ?? null,
  };

  const embeddingLiteral = toVectorLiteral(await embed(compiledTruth));
  await upsertRulePageRow(sql, {
    sourceId,
    slug,
    title: dbTitle,
    compiledTruth,
    frontmatter,
    embeddingLiteral,
    contentHash: hash,
  });
  return true;
}

/**
 * Pulls whatever changed in `repoPath` (already cloned/pulled by the
 * caller) into the org's native rows. First call for a source (no stored
 * `last_commit`) does a full walk of rules/; every call after that diffs
 * `last_commit..HEAD` and touches only what changed.
 */
export async function nativeSync(
  sql: PgSql,
  embed: EmbedFn,
  opts: { orgId: string; sourceId: string; repoPath: string },
): Promise<NativeSyncResult> {
  const { orgId, sourceId, repoPath } = opts;
  const toCommit = await git(repoPath, ["rev-parse", "HEAD"]);

  const sourceRows = await sql<{ last_commit: string | null }[]>`
    SELECT last_commit FROM sources WHERE id = ${sourceId}
  `;
  const fromCommit = sourceRows[0]?.last_commit ?? null;

  if (fromCommit === toCommit) {
    return { status: "up_to_date", fromCommit, toCommit, added: 0, modified: 0, deleted: 0, embedded: 0, pagesAffected: [] };
  }

  const manifest = fromCommit ? await diffRuleFiles(repoPath, fromCommit, toCommit) : null;

  let added = 0;
  let modified = 0;
  let deleted = 0;
  let embedded = 0;
  const pagesAffected: string[] = [];

  if (manifest) {
    for (const relPath of manifest.deleted) {
      const slug = slugForRulePath(relPath);
      const result = await sql`DELETE FROM pages WHERE source_id = ${sourceId} AND slug = ${slug}`;
      if (result.count > 0) {
        deleted++;
        pagesAffected.push(slug);
      }
    }
    for (const relPath of manifest.added) {
      if (await importOneFile(sql, embed, { orgId, sourceId, repoPath, relPath })) {
        added++;
        embedded++;
        pagesAffected.push(slugForRulePath(relPath));
      }
    }
    for (const relPath of manifest.modified) {
      if (await importOneFile(sql, embed, { orgId, sourceId, repoPath, relPath })) {
        modified++;
        embedded++;
        pagesAffected.push(slugForRulePath(relPath));
      }
    }
  } else {
    // First sync, or the bookmarked commit is unreachable (rewritten
    // history) — full walk, same fail-open shape as the engine's own
    // "diff unavailable -> full-tree ceiling" ladder.
    for (const relPath of listRuleFilesOnDisk(repoPath)) {
      if (await importOneFile(sql, embed, { orgId, sourceId, repoPath, relPath })) {
        added++;
        embedded++;
        pagesAffected.push(slugForRulePath(relPath));
      }
    }
  }

  await sql`UPDATE sources SET last_commit = ${toCommit} WHERE id = ${sourceId}`;

  return {
    status: fromCommit ? "synced" : "first_sync",
    fromCommit,
    toCommit,
    added,
    modified,
    deleted,
    embedded,
    pagesAffected,
  };
}

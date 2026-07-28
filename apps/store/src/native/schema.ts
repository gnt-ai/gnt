/**
 * Native Postgres/pgvector schema bootstrap. INHERITS the vendored engine's
 * production table shapes for the subset this store actually touches —
 * production data stays exactly where it is, cutover is code-only, no
 * migration and no re-embedding.
 *
 * Every statement is idempotent (IF NOT EXISTS) and matches the engine's
 * own table/index/constraint NAMES exactly, not just their shapes: on a
 * database the engine already initialized, every one of these is a true
 * no-op (name collision short-circuits before Postgres compares columns).
 * On a fresh database, this creates a lean pages/content_chunks/sources
 * schema carrying only the columns this store reads or writes — the
 * engine's own schema.sql (~1400 lines) additionally covers code search,
 * graph edges, contextual-retrieval caching, and a dozen other subsystems
 * this store has no use for; none of that is reproduced here.
 *
 * embedding vector(1280) is hardcoded, not derived from an env var or
 * config row the way the engine's own schema templating does it — the
 * dimension is fixed to ZeroEntropy zembed-1's output width and is NOT a
 * swappable knob (see EngineStore's own EMBEDDING_DIMENSIONS comment):
 * changing it without a coordinated migration silently breaks every
 * existing chunk's cosine comparison.
 */

export const NATIVE_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

-- Multi-tenant isolation boundary: one row per org (see
-- ../core/source-paths.ts::normalizeSourceId for the org id -> id mapping).
-- Column subset of the engine's own "sources" table — local_path/config are
-- the two fields registerGithubSource actually reads and writes.
CREATE TABLE IF NOT EXISTS sources (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  local_path      TEXT,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Sync bookmark (native/sync.ts). Same column name as the engine's own
-- sources.last_commit -- true no-op on a database the engine already
-- migrated.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_commit TEXT;

-- Column subset of the engine's own "pages" table. Slugs are unique per
-- source, not globally, via the same (source_id, slug) constraint name the
-- engine uses — ON CONFLICT targets this by column list, not by name, but
-- matching the name keeps a psql "describe pages" diff clean against
-- production.
CREATE TABLE IF NOT EXISTS pages (
  id             SERIAL PRIMARY KEY,
  source_id      TEXT    NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  slug           TEXT    NOT NULL,
  type           TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  compiled_truth TEXT    NOT NULL DEFAULT '',
  frontmatter    JSONB   NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Soft-delete column the engine's own getPage/listPages always filter on
  -- by default. Nothing in this store's own write paths ever sets it, but
  -- a shared production database could carry rows from another engine
  -- feature that does — filtering it keeps read parity either way.
  deleted_at     TIMESTAMPTZ,
  CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages(source_id);
CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type);
-- Sync change-detection (native/sync.ts). Same column name as the engine's
-- own pages.content_hash -- true no-op on a database the engine already
-- migrated. This store's own hash algorithm (sha256 of the raw synced
-- file) differs from the engine's (sha256 of parsed fields), so a row the
-- engine's git-native sync previously wrote always re-embeds once on its
-- first native sync -- see native/sync.ts's header comment.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- Column subset of the engine's own "content_chunks" table. This store
-- writes exactly one chunk per page (chunk_index 0, the compiled title+body
-- text) — the engine's own multi-chunk/code/multimodal columns
-- (symbol_name, embedding_image, parent_symbol_path, ...) are never
-- populated by this store and aren't reproduced here.
CREATE TABLE IF NOT EXISTS content_chunks (
  id           SERIAL PRIMARY KEY,
  page_id      INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL,
  chunk_text   TEXT    NOT NULL,
  chunk_source TEXT    NOT NULL DEFAULT 'compiled_truth',
  embedding    vector(1280),
  model        TEXT    NOT NULL DEFAULT 'zeroentropyai:zembed-1',
  embedded_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_page_index ON content_chunks(page_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON content_chunks(page_id);
-- 1280 <= pgvector's 2000-dim HNSW ceiling, so this always builds a real
-- index (see the engine's own vector-index.ts::chunkEmbeddingIndexSql for
-- the dimension check this mirrors).
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);

-- Keyword-search support (search.ts's keyword arm). Column/index/trigger
-- names match the vendored engine's own migrations exactly, so this is a
-- true no-op on a database the engine already bootstrapped. doc_comment
-- and symbol_name_qualified are never populated by this store's own
-- writes (code-search-only columns upstream) but the trigger function
-- references them unconditionally, so they have to exist for the trigger
-- to fire without error.
ALTER TABLE content_chunks
  ADD COLUMN IF NOT EXISTS doc_comment TEXT,
  ADD COLUMN IF NOT EXISTS symbol_name_qualified TEXT,
  ADD COLUMN IF NOT EXISTS search_vector TSVECTOR,
  ADD COLUMN IF NOT EXISTS modality TEXT NOT NULL DEFAULT 'text';
CREATE INDEX IF NOT EXISTS idx_chunks_search_vector ON content_chunks USING GIN(search_vector);

CREATE OR REPLACE FUNCTION update_chunk_search_vector() RETURNS TRIGGER AS $fn$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.doc_comment, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.symbol_name_qualified, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.chunk_text, '')), 'B');
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chunk_search_vector_trigger ON content_chunks;
CREATE TRIGGER chunk_search_vector_trigger
  BEFORE INSERT OR UPDATE OF chunk_text, doc_comment, symbol_name_qualified
  ON content_chunks
  FOR EACH ROW EXECUTE FUNCTION update_chunk_search_vector();

-- Read-only fallback for pages written by the engine's own markdown
-- importer, which promotes frontmatter tags out to this table instead of
-- leaving them in frontmatter.tags (see NativeStore's getPage/listPages
-- tags-fallback comment). This store never writes to this table itself.
CREATE TABLE IF NOT EXISTS tags (
  id      SERIAL PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag     TEXT    NOT NULL,
  UNIQUE(page_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_tags_page_id ON tags(page_id);

-- Backs appendAudit/getAuditTrail. idx_timeline_dedup matches the engine's
-- ON CONFLICT (page_id, date, summary, source) DO NOTHING target exactly.
CREATE TABLE IF NOT EXISTS timeline_entries (
  id         SERIAL PRIMARY KEY,
  page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  date       DATE    NOT NULL,
  source     TEXT    NOT NULL DEFAULT '',
  summary    TEXT    NOT NULL,
  detail     TEXT    NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_timeline_page ON timeline_entries(page_id);
CREATE INDEX IF NOT EXISTS idx_timeline_date ON timeline_entries(date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_dedup ON timeline_entries(page_id, date, summary, source);
`;

/** Runs the bootstrap above through a live connection. Safe to call on
 * every init() — every statement is IF NOT EXISTS, so a second call against
 * an already-bootstrapped database (native-created or engine-created) does
 * nothing. */
export async function bootstrapNativeSchema(sql: { unsafe(query: string): Promise<unknown> }): Promise<void> {
  await sql.unsafe(NATIVE_SCHEMA_SQL);
}

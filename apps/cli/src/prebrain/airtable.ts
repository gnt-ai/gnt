// Live-Airtable client: the one connector in this
// sprint where a base's schema is entirely customer-defined, so there is no
// safe field list this file could hardcode the way every other connector
// here does. Direct against Airtable's own REST/Metadata API, not an MCP
// adapter -- same "no framework, hand-kept field discipline" shape as
// ../figma-comments.ts and ../datadog-notebooks.ts, with one real
// difference: the field allowlist itself isn't declared in this file at
// all. It's customer-chosen, per table, in the interactive connect flow
// (../../commands/connect-airtable.ts) and persisted alongside the token.
// This file's job is to make that saved list a structural boundary once it
// exists, not merely a remembered preference -- see "Field discipline"
// below.
//
// -- Endpoint, auth, and response shapes --
// Personal access token, `Authorization: Bearer <token>` on every request --
// Airtable's own self-serve token model (airtable.com/create/tokens), no
// vendor approval. Confirmed against Airtable's own published Web API
// reference (airtable.com/developers/web/api):
//   GET https://api.airtable.com/v0/meta/bases
//     -> { bases: [{ id, name, permissionLevel }], offset? } -- every base
//     this token can reach. This is both the connect flow's base-picker
//     listing and its live-validation probe (least destructive read this
//     API offers, same role Figma's /v1/me and Datadog's list-notebooks
//     call play for their own connect flows) -- one call does both jobs.
//   GET https://api.airtable.com/v0/meta/bases/{baseId}/tables
//     -> { tables: [{ id, name, primaryFieldId, fields: [{ id, name, type,
//     options? }], views: [...] }] } -- a base's real, live schema.
//     Requires the schema.bases:read scope on the token.
//   GET https://api.airtable.com/v0/{baseId}/{tableIdOrName}?fields=...
//     -> { records: [{ id, createdTime, fields: { [fieldName]: value } }],
//     offset? } -- paginated (pageSize up to 100, offset-based). Requires
//     data.records:read. `fields` (repeated once per name) is Airtable's
//     own documented way to ask this endpoint to omit every other field
//     server-side; fetchTableRecords below always sends the saved table's
//     allowed field names there.
// AIRTABLE_ENDPOINTS below is the exhaustive, exported list of every REST
// path this file ever calls, same role DATADOG_ENDPOINTS plays for
// datadog-notebooks.ts.
//
// -- Field discipline (the point of this whole connector) --
// Every other connector in this sprint declares its safe field set in its
// own source, at build time, because the target object's shape is
// vendor-fixed (a Figma comment always has the same keys; a Datadog
// notebook cell always has the same definition shape). An Airtable base's
// fields are entirely customer-defined -- one customer's "Notes" column
// might be genuine prose, another's identically-named column might hold a
// customer ID or a phone number -- so this file has no way to know which
// fields are safe at build time. The allowlist lives outside this file
// instead: the customer picks it, per table, against that base's real live
// schema (see connect-airtable.ts), and it's persisted next to the token
// as part of AirtableConnectorConfig below. Once that list exists, this
// file's only job is to make it a hard boundary the same way
// mcp-framework/fields.ts's projectToDeclaredFields makes a build-time
// declaration one: buildRecordDocument runs a record's raw `fields` object
// through that exact function, passing the saved table's allowed field
// names as the allowed set, before any of this file's own code reads a
// single field value. A field the customer didn't pick is gone at that
// point, not merely unread -- reusing the framework's own projection
// function directly rather than reimplementing it, since the underlying
// operation (recursively keep only declared keys, drop everything else at
// every depth) is identical regardless of where the declaration came from.
//
// -- Scope control --
// A table with zero fields selected is never read at all, not read and
// then discarded -- see walkAirtable's own empty-allowlist short-circuit.
// That's the plan's own stated failure mode this connector exists to
// prevent: "no allowlist, no connector."
import { chunkText, classifyDecisionProse } from "./chunk.js";
import { projectToDeclaredFields } from "./mcp-framework/fields.js";
import type { PrebrainChunk } from "./types.js";

export const AIRTABLE_TOKEN_ID = "airtable";

export const AIRTABLE_API_BASE = "https://api.airtable.com";

const REQUEST_TIMEOUT_MS = 15_000;

// Same "seed a first rulebook, not a mirror of a table's entire history"
// bound as MAX_THREADS_PER_FILE (figma-comments.ts) / MAX_ITEMS_PER_BOARD
// (mcp-monday.ts) -- applied per table, across as many pages as it takes to
// reach it.
const MAX_RECORDS_PER_TABLE = 200;
const PAGE_SIZE = 100;

// Field types Airtable's own field model documents as long-form prose --
// "Long text" (multilineText), "Long text with rich text formatting"
// (richText), and "Long text with AI output" (aiText) -- surfaced in the
// connect flow as a "(recommended)" hint next to a field, never
// auto-selected. See connect-airtable.ts's own field-picker step: the
// customer's explicit choice is what gets saved, this only decides which
// rows get the hint.
export const PROSE_SHAPED_FIELD_TYPES: ReadonlySet<string> = new Set(["multilineText", "richText", "aiText"]);

export class MissingAirtableTokenError extends Error {
  constructor() {
    super("No Airtable token found. Run `gnt connect airtable`, pass --airtable-token, or set GNT_AIRTABLE_TOKEN.");
    this.name = "MissingAirtableTokenError";
  }
}

// Distinct from MissingAirtableTokenError: this fires when gnt prebrain
// --airtable runs with no saved connection at all (never ran `gnt connect
// airtable`), where the missing thing isn't just a token but the whole
// base/tables/fields selection a token alone can't stand in for.
export class MissingAirtableConfigError extends Error {
  constructor() {
    super("No Airtable connection found. Run `gnt connect airtable` first to pick a base, tables, and safe fields.");
    this.name = "MissingAirtableConfigError";
  }
}

export class AirtableApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AirtableApiError";
  }
}

// Same explicit-token > env var > stored-token precedence every other
// connector in this CLI uses (see figma-comments.ts's resolveFigmaToken).
// walkAirtable is the one caller: `storedToken` there is always the saved
// config's own token, never a bare pasted one -- connectAirtable doesn't
// need this, it only ever takes a fresh pasted token with nothing stored
// yet to fall back to.
export function resolveAirtableToken(explicit: string | undefined, storedToken: string | undefined): string {
  const token = explicit ?? process.env.GNT_AIRTABLE_TOKEN ?? storedToken;
  if (!token) throw new MissingAirtableTokenError();
  return token;
}

export interface AirtableBaseSummary {
  id: string;
  name: string;
  permissionLevel: string;
}

export interface AirtableFieldSchema {
  id: string;
  name: string;
  type: string;
}

export interface AirtableTableSchema {
  id: string;
  name: string;
  fields: AirtableFieldSchema[];
}

// One table's saved scope: which table, and exactly which field NAMES the
// customer picked as safe prose. Names, not field ids -- Airtable's own
// records endpoint keys a record's `fields` object by field name by
// default, so this has to match that key space for projectToDeclaredFields
// to strip against it correctly.
export interface AirtableTableSelection {
  tableId: string;
  tableName: string;
  allowedFields: string[];
}

// The one thing `gnt connect airtable` produces and `gnt prebrain
// --airtable` reads back -- a token plus a base plus, per table, an
// explicit field allowlist, saved together as a single unit under
// AIRTABLE_TOKEN_ID (see ../credentials.ts's saveMcpToken/loadMcpToken).
// Same "mcp-tokens.json stores one string per id, this file just knows the
// string is structured JSON" shape datadog-notebooks.ts's
// DatadogCredentials already uses, one level deeper since this connector
// has a table/field selection to carry, not just secrets.
export interface AirtableConnectorConfig {
  token: string;
  baseId: string;
  baseName: string;
  tables: AirtableTableSelection[];
}

export function serializeAirtableConfig(config: AirtableConnectorConfig): string {
  return JSON.stringify(config);
}

function parseStoredTableSelection(raw: unknown): AirtableTableSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.tableId !== "string" || !obj.tableId) return null;
  if (typeof obj.tableName !== "string" || !obj.tableName) return null;
  const allowedFields = Array.isArray(obj.allowedFields)
    ? obj.allowedFields.filter((f): f is string => typeof f === "string" && f.length > 0)
    : [];
  return { tableId: obj.tableId, tableName: obj.tableName, allowedFields };
}

// Parses the JSON envelope saveMcpToken(AIRTABLE_TOKEN_ID, ...) wrote --
// returns null for anything missing, malformed, or pre-dating this shape,
// same "drop what doesn't parse, never guess" bias every parser in this
// directory keeps, rather than throwing and turning a corrupt local file
// into a crash.
function parseStoredAirtableConfig(raw: string | undefined): AirtableConnectorConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.token !== "string" || !obj.token) return null;
    if (typeof obj.baseId !== "string" || !obj.baseId) return null;

    const tablesRaw = Array.isArray(obj.tables) ? obj.tables : [];
    const tables: AirtableTableSelection[] = [];
    for (const entry of tablesRaw) {
      const table = parseStoredTableSelection(entry);
      if (table) tables.push(table);
    }

    return {
      token: obj.token,
      baseId: obj.baseId,
      baseName: typeof obj.baseName === "string" ? obj.baseName : obj.baseId,
      tables,
    };
  } catch {
    return null;
  }
}

// `gnt status`'s own health-line check. This connector isn't in
// MCP_IN_ADAPTERS -- it's a direct-REST connector, not an MCP-in one, same
// as figma-comments.ts/datadog-notebooks.ts -- so it doesn't come from
// mcpConnectorHealth() for free; status.ts calls this directly instead.
// Reuses parseStoredAirtableConfig rather than a second hand-rolled parse,
// so "connected" here means exactly what walkAirtable would accept, not a
// looser or stricter definition of it.
export function hasStoredAirtableConnection(raw: string | undefined): boolean {
  return parseStoredAirtableConfig(raw) !== null;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function describeFetchError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Best-effort read of Airtable's own error payload shape (`{ error: { type,
// message } }`, occasionally just `{ error: "SOME_CODE" }` for simpler
// failures), falling back to a bare status code when the body isn't JSON or
// doesn't match either shape. Never includes the token -- it only ever
// travels in the request's own Authorization header, never echoed here.
async function describeErrorResponse(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const errorField = body && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;

  let detail: string | undefined;
  if (errorField && typeof errorField === "object") {
    const errObj = errorField as Record<string, unknown>;
    detail = typeof errObj.message === "string" ? errObj.message : typeof errObj.type === "string" ? errObj.type : undefined;
  } else if (typeof errorField === "string" && errorField) {
    detail = errorField;
  }

  return detail ? `${res.status}: ${detail}` : `HTTP ${res.status}`;
}

// See this file's own top-of-file "Scope control" section -- the
// exhaustive set of REST endpoints this connector ever calls, exported so
// a test can assert the walk path and the connect-flow path each only
// touch what they're documented to touch.
export const AIRTABLE_ENDPOINTS: readonly { path: string; description: string }[] = [
  {
    path: "GET /v0/meta/bases",
    description:
      "List bases this token can access; the connect flow's base picker and its credential-validation probe, both in one call.",
  },
  {
    path: "GET /v0/meta/bases/{baseId}/tables",
    description: "List a base's live tables and fields; used only during the connect flow to build the field picker, never during a walk.",
  },
  {
    path: "GET /v0/{baseId}/{tableIdOrName}",
    description:
      "List a table's records, paginated, scoped server-side to the saved allowlist via a repeated fields param; the only endpoint a prebrain walk ever calls.",
  },
];

function extractBases(data: unknown): AirtableBaseSummary[] {
  const list =
    data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).bases)
      ? ((data as Record<string, unknown>).bases as unknown[])
      : [];

  const bases: AirtableBaseSummary[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.id !== "string" || !obj.id) continue;
    bases.push({
      id: obj.id,
      name: typeof obj.name === "string" && obj.name ? obj.name : obj.id,
      permissionLevel: typeof obj.permissionLevel === "string" ? obj.permissionLevel : "unknown",
    });
  }
  return bases;
}

// Lists every base this token can access -- the connect flow's base
// picker, and (by being the least-destructive authenticated read this API
// offers, same role Figma's /v1/me plays) also its own live-validation
// probe. See this file's own "Endpoint, auth, and response shapes" section.
export async function listAccessibleBases(token: string, fetchImpl: typeof fetch = fetch): Promise<AirtableBaseSummary[]> {
  let res: Response;
  try {
    res = await fetchImpl(`${AIRTABLE_API_BASE}/v0/meta/bases`, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AirtableApiError(`Couldn't reach Airtable: ${describeFetchError(err)}`);
  }
  if (!res.ok) {
    throw new AirtableApiError(`Airtable rejected that token (${await describeErrorResponse(res)})`);
  }
  const data = await res.json().catch(() => null);
  return extractBases(data);
}

function extractFieldSchema(raw: unknown): AirtableFieldSchema | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id) return null;
  if (typeof obj.name !== "string" || !obj.name) return null;
  return { id: obj.id, name: obj.name, type: typeof obj.type === "string" ? obj.type : "unknown" };
}

function extractTableSchema(raw: unknown): AirtableTableSchema | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id) return null;
  if (typeof obj.name !== "string" || !obj.name) return null;

  const fieldsRaw = Array.isArray(obj.fields) ? obj.fields : [];
  const fields: AirtableFieldSchema[] = [];
  for (const entry of fieldsRaw) {
    const parsed = extractFieldSchema(entry);
    if (parsed) fields.push(parsed);
  }

  return { id: obj.id, name: obj.name, fields };
}

// Reads a base's live schema -- every table and every field, with each
// field's own declared `type` -- for the connect flow's table/field picker.
// This is the one read in this file that touches a base's structure rather
// than its content; it never reads a single record. Called only from
// connect-airtable.ts, never from walkAirtable (see this file's own
// AIRTABLE_ENDPOINTS description for that endpoint).
export async function getBaseSchema(baseId: string, token: string, fetchImpl: typeof fetch = fetch): Promise<AirtableTableSchema[]> {
  let res: Response;
  try {
    res = await fetchImpl(`${AIRTABLE_API_BASE}/v0/meta/bases/${encodeURIComponent(baseId)}/tables`, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AirtableApiError(`Couldn't reach Airtable for base ${baseId}: ${describeFetchError(err)}`);
  }
  if (!res.ok) {
    throw new AirtableApiError(`Airtable schema request failed for base ${baseId} (${await describeErrorResponse(res)})`);
  }

  const data = await res.json().catch(() => null);
  const list =
    data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).tables)
      ? ((data as Record<string, unknown>).tables as unknown[])
      : [];

  const tables: AirtableTableSchema[] = [];
  for (const entry of list) {
    const parsed = extractTableSchema(entry);
    if (parsed) tables.push(parsed);
  }
  return tables;
}

interface RawAirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

function extractRecords(data: unknown): RawAirtableRecord[] {
  const list =
    data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).records)
      ? ((data as Record<string, unknown>).records as unknown[])
      : [];

  const records: RawAirtableRecord[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.id !== "string" || !obj.id) continue;
    const fields = obj.fields && typeof obj.fields === "object" ? (obj.fields as Record<string, unknown>) : {};
    records.push({ id: obj.id, fields });
  }
  return records;
}

function nextOffset(data: unknown): string | undefined {
  if (data && typeof data === "object" && typeof (data as Record<string, unknown>).offset === "string") {
    return (data as Record<string, unknown>).offset as string;
  }
  return undefined;
}

// Paginates through a table's records up to MAX_RECORDS_PER_TABLE.
// `allowedFields` is sent as this request's own `fields` query param
// (repeated once per field name, Airtable's own documented way to ask the
// list-records endpoint to omit everything else server-side) -- an
// unpicked field's value never leaves Airtable's servers at all, not just
// unread once it arrives. That's a request hint, not this connector's own
// enforcement boundary: buildRecordDocument still runs every record
// through projectToDeclaredFields against this same allowed set before
// this file's own code reads a single value, so a field that somehow came
// back anyway (a stale cache, a future API change) is still stripped, not
// trusted.
async function fetchTableRecords(
  baseId: string,
  tableId: string,
  token: string,
  allowedFields: ReadonlySet<string>,
  fetchImpl: typeof fetch,
): Promise<RawAirtableRecord[]> {
  const records: RawAirtableRecord[] = [];
  let offset: string | undefined;

  do {
    const url = new URL(`${AIRTABLE_API_BASE}/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`);
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    // Airtable's List Records endpoint only accepts array-typed query
    // params in bracket notation (fields[]=..., repeated once per value) --
    // confirmed against the real API, which 422s on a bare repeated
    // fields=... the way URLSearchParams.append naturally produces.
    for (const fieldName of allowedFields) url.searchParams.append("fields[]", fieldName);
    if (offset) url.searchParams.set("offset", offset);

    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        headers: authHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new AirtableApiError(`Couldn't reach Airtable for table ${tableId}: ${describeFetchError(err)}`);
    }
    if (!res.ok) {
      throw new AirtableApiError(`Airtable records request failed for table ${tableId} (${await describeErrorResponse(res)})`);
    }

    const data = await res.json().catch(() => null);
    records.push(...extractRecords(data));
    offset = nextOffset(data);
  } while (offset && records.length < MAX_RECORDS_PER_TABLE);

  return records.slice(0, MAX_RECORDS_PER_TABLE);
}

// The structural boundary this whole connector exists to build -- see this
// file's own top-of-file "Field discipline" section. `allowedFields` is
// this record's own table's saved selection, nothing more.
// projectToDeclaredFields strips every key not in it, recursively, before
// this function reads a single value; only a declared field whose
// projected value is a non-blank string becomes part of the document --
// a declared field of some other shape (a number, a linked-record array, a
// blank cell) is walked past rather than stringified and guessed at, same
// "prose only" bias the rest of this connector keeps.
function buildRecordDocument(tableName: string, record: RawAirtableRecord, allowedFields: ReadonlySet<string>): string {
  const projected = projectToDeclaredFields(record.fields, allowedFields) as Record<string, unknown>;

  const sections: string[] = [];
  for (const fieldName of allowedFields) {
    const value = projected[fieldName];
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!text) continue;
    sections.push(`## ${fieldName}\n\n${text}`);
  }
  if (sections.length === 0) return "";

  return [`# ${tableName} record`, ...sections].join("\n\n");
}

// Airtable's own record deep-link shape: https://airtable.com/<baseId>/
// <tableId>/<recordId> opens that exact record in the base. A real vendor
// URL, not a stable-id fallback -- every value it needs (base id, table id,
// record id) is already in hand from the config and the records read, no
// extra call required, same "real deep link when nothing extra is needed
// for one" choice datadog-notebooks.ts's notebookUrl makes.
function recordUrl(baseId: string, tableId: string, recordId: string): string {
  return `https://airtable.com/${baseId}/${tableId}/${recordId}`;
}

export interface WalkAirtableOptions {
  /** Overrides just the stored token -- base/tables/fields always come from storedConfig, see this function's own doc comment for why. */
  token?: string;
  /** The JSON envelope `gnt connect airtable` saved (see ../credentials.ts's loadMcpToken(AIRTABLE_TOKEN_ID)). */
  storedConfig?: string;
  /** Injectable seam for tests -- defaults to the real global fetch. */
  fetchImpl?: typeof fetch;
}

// Public walker. Unlike every other connector in this sprint, this one
// takes no per-run scope parameters at all beyond an optional token
// override -- the base, the tables, and the field allowlist are decided
// once, interactively, against a base's real live schema, and persisted
// together as one unit (see connect-airtable.ts and
// AirtableConnectorConfig above). Re-opening that decision on every `gnt
// prebrain` run would mean either re-prompting a human mid-run or offering
// a flag that could silently widen the allowlist past what was explicitly
// reviewed -- exactly the shortcut this task's own framing rules out ("the
// field-allowlist UX is mandatory and blocking"). So --airtable is a bare
// boolean in commands/prebrain.ts: it reads back whatever `gnt connect
// airtable` already saved, or fails clearly if nothing was.
//
// A table with zero saved fields is skipped before fetchTableRecords is
// ever called -- never read and then discarded, never read at all. A table
// id that fails outright (renamed/deleted table, revoked token, rate
// limit) throws AirtableApiError and aborts the rest of this walker's own
// run, same granularity every other REST walker in this directory keeps;
// commands/prebrain.ts's own try/catch turns that into a single "Airtable
// walker skipped: <message>" line, and the rest of `gnt prebrain` still
// completes.
export async function walkAirtable(options: WalkAirtableOptions = {}): Promise<PrebrainChunk[]> {
  const config = parseStoredAirtableConfig(options.storedConfig);
  if (!config) throw new MissingAirtableConfigError();

  const token = resolveAirtableToken(options.token, config.token);
  const fetchImpl = options.fetchImpl ?? fetch;

  const chunks: PrebrainChunk[] = [];
  for (const table of config.tables) {
    if (table.allowedFields.length === 0) continue;

    const allowedFields = new Set(table.allowedFields);
    const records = await fetchTableRecords(config.baseId, table.tableId, token, allowedFields, fetchImpl);

    for (const record of records) {
      const body = buildRecordDocument(table.tableName, record, allowedFields);
      if (!body.trim()) continue;

      const sourcePath = recordUrl(config.baseId, table.tableId, record.id);
      for (const chunk of chunkText(body)) {
        chunks.push({
          text: chunk.text,
          sourcePath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          walker: "airtable",
          looksLikeDecisionProse: classifyDecisionProse(chunk.text),
        });
      }
    }
  }

  return chunks;
}

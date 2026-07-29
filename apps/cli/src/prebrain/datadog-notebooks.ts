// Live-Datadog notebooks client: reads a
// customer-named Datadog notebook's own title and markdown prose -- nothing
// else -- as decision-prose and incident-postmortem candidates. Direct
// against Datadog's own REST API, not an MCP adapter: see "Why this isn't
// an MCP-in connector" below for the transport mismatch that ruled that
// shape out. Same "no framework, hand-kept field discipline" shape as
// ../figma-comments.ts -- read that file's own doc comment alongside this
// one for the shared reasoning this file doesn't repeat.
//
// -- Why this isn't an MCP-in connector --
// Datadog does publish an official MCP server (docs.datadoghq.com/mcp_server/,
// generally available as of this connector's build) with directly callable
// notebook tools -- get_datadog_notebook and search_datadog_notebooks both
// sit in its "core" toolset alongside create_datadog_notebook/
// edit_datadog_notebook (write tools) and dozens of metrics/monitors/logs/
// dashboards/incidents tools. That bundling isn't itself disqualifying --
// this framework's allowlist enforces by exact declared tool name
// regardless of what else a live server advertises (see mcp-sentry.ts's
// own doc comment for the same reasoning applied to Sentry's server), so a
// two-tool allowlist naming only the notebook reads would have kept
// monitors/logs/metrics unreachable through an adapter built this way.
//
// What actually rules the MCP shape out is transport, not scope. Datadog's
// own setup docs (docs.datadoghq.com/mcp_server/setup.md) describe a
// remote HTTP MCP endpoint (mcp.datadoghq.com/api/unstable/mcp-server/mcp)
// authenticated over OAuth 2.0 or bearer/API-key HTTP headers as the
// primary, recommended deployment -- and this codebase's mcp-connector.ts
// (a framework core file this task doesn't own) only ever speaks one
// transport: connectStdioMcpServer spawns a local child process over
// stdio, the same shape every other MCP-in adapter here (Notion, monday,
// Linear, Sentry, Granola) uses with an `npx -y <published-npm-package>`
// command. Datadog's docs do mention a local-binary fallback ("local
// authentication is recommended ... when remote authentication is
// unreliable"), but that binary is fetched with a vendor-hosted
// curl-pipe-bash installer, not an npm package this CLI can pin and spawn
// with `npx -y` the way every existing stdio adapter does -- a materially
// different trust and connect-flow story than the rest of this framework,
// and not something a single connector's task should paper over by
// quietly shelling out to a pre-installed binary on the customer's own
// PATH. Building a remote-HTTP-plus-OAuth transport into mcp-connector.ts
// would be real, generalizable framework work belonging to its own task,
// not something to bolt on inside one adapter file -- flagged here rather
// than attempted. A direct REST client against Datadog's own long-stable,
// documented Notebooks API sidesteps the whole question the same way
// figma-comments.ts already did for a different reason (no vendor comment-
// reading MCP tool existed at all there; here the tools exist but the only
// transport this framework speaks doesn't reach them).
//
// -- Endpoint, auth, and response shape --
// GET https://api.<site>/api/v1/notebooks/<id> returns a single notebook:
// `{ data: { id, type: "notebooks", attributes: { name, cells: [...],
// status, author, created, modified, time } } }`. Each entry in `cells` is
// `{ id, type: "notebook_cells", attributes: { definition: { type, ... } } }`
// -- `definition.type` is one of several cell kinds Datadog documents
// (markdown, timeseries, toplist, heatmap, distribution, log_stream, and
// more): a `markdown` cell's own definition carries a `text` field with
// the cell's actual written prose; every other cell type's definition
// instead carries a query or request against metrics, logs, or monitors --
// the exact structured telemetry this connector must never read (see
// "Field discipline" below). GET https://api.<site>/api/v1/notebooks
// (list) is used only as this connector's connect-flow validation probe --
// see "Scope control" below for why the walk itself never calls it. Auth
// is two headers on every request, DD-API-KEY and DD-APPLICATION-KEY,
// Datadog's own long-stable, self-serve REST convention -- no vendor
// approval or app review, same "customer mints their own credential" shape
// as every other connector's token in this sprint.
//
// -- Notebooks and incident postmortems are the same object --
// This connector's design anticipated needing a second, separate read path
// for postmortems if Datadog tracked them as a distinct object type --
// only worth adding if that object turned out to still be pure prose.
// Datadog's own incident-management docs (docs.datadoghq.com/incident_response/
// incident_management/post_incident/postmortems/) resolve this without a
// fork: postmortem templates generate a Notebook directly -- Datadog
// Incident Management populates a new Notebook with the incident's key
// data when a postmortem is created -- there is no separate postmortem
// object or API. One read path (this file's) covers both, and the
// separate Incidents API (severity, affected services, structured
// timeline events) is never called here at all, not merely unread -- there
// is no code path from this file to it. A generated postmortem notebook
// can embed a live `{{incident.card}}` template token that Datadog's own
// web app renders into a summary card at view time; this connector only
// ever reads a cell's raw markdown source text over the API, never a
// rendered view, so a token like that reaches a chunk as the literal
// placeholder string, not as fetched incident data.
//
// -- Field discipline --
// No framework here to strip undeclared fields structurally -- same
// hand-kept discipline figma-comments.ts documents in its own "Field
// discipline" section. extractNotebookDocument below reads exactly two
// things off a notebook response: `attributes.name` (the notebook's own
// title) and, per cell, `attributes.definition.text` -- and only when that
// same cell's `attributes.definition.type` is exactly `"markdown"`. Every
// non-markdown cell's `definition` (its query, its request list, its time
// window) is walked past and never read into a variable. `status`,
// `author` (a commenter identity, the same shape Figma's own `user` object
// carries), `created`/`modified` timestamps, and the notebook-level `time`
// range are never read at all. datadog-notebooks.test.ts proves this
// against a fixture shaped like Datadog's real response, including a
// timeseries cell whose definition carries a metric query and an author
// object with a real name and email, and checks the produced chunks for
// their absence.
//
// -- Scope control --
// Same "customer supplies the exact list, this connector never
// auto-discovers" bias as every other adapter in this framework (see
// mcp-monday.ts's board ids, mcp-sentry.ts's project slugs, figma-
// comments.ts's file keys) -- notebookIds is a required walk param, read
// one at a time by id via GET .../notebooks/<id>, never resolved by
// listing an org's notebooks first. DATADOG_ENDPOINTS below is the
// exhaustive, exported list of every REST path this file ever calls -- the
// hand-kept equivalent of an MCP adapter's declared `reads` allowlist (see
// mcp-framework/README.md's "Declare your reads" section) -- so a test can
// assert neither a metrics, monitors, nor logs endpoint is ever declared,
// not just that one happens to be unused. The List Notebooks endpoint is
// declared and used only as the connect flow's own probe (see
// validateDatadogCredentials below), the same "one minimal live read
// before anything is saved" role Figma's /v1/me and Sentry's
// find_organizations both play -- unlike those two, Datadog has no truly
// content-free authenticated endpoint this connector found, so the probe
// does touch real notebook titles rather than none at all; that's called
// out here rather than glossed over.
import { chunkText, classifyDecisionProse } from "./chunk.js";
import type { PrebrainChunk } from "./types.js";

export const DATADOG_TOKEN_ID = "datadog";

export const DEFAULT_DATADOG_SITE = "datadoghq.com";

const REQUEST_TIMEOUT_MS = 15_000;

// See this file's own top-of-file "Scope control" section -- the
// exhaustive set of REST endpoints this connector ever calls, exported so
// tests can assert none of them (or their own descriptions) ever reference
// metrics, monitors, or logs.
export const DATADOG_ENDPOINTS: readonly { path: string; description: string }[] = [
  {
    path: "GET /api/v1/notebooks/{notebook_id}",
    description: "Fetch one notebook's title and markdown cell text by id.",
  },
  {
    path: "GET /api/v1/notebooks",
    description: "List notebooks; used only as the connect-flow credential-validation probe, never during a walk.",
  },
];

export class MissingDatadogCredentialsError extends Error {
  constructor() {
    super(
      "No Datadog credentials found. Run `gnt connect datadog`, pass --datadog-api-key and --datadog-app-key, " +
        "or set GNT_DATADOG_API_KEY and GNT_DATADOG_APP_KEY.",
    );
    this.name = "MissingDatadogCredentialsError";
  }
}

export class DatadogApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatadogApiError";
  }
}

export interface DatadogCredentials {
  apiKey: string;
  appKey: string;
  site: string;
}

// mcp-tokens.json stores one string per connector id (see ../credentials.ts).
// Datadog needs two secrets plus an optional site, so this connector's
// stored "token" is a small JSON envelope rather than a bare string -- the
// storage layer itself stays untouched (still `{ "<id>": "<string>" }`),
// only this file knows the string it stores is structured.
export function serializeDatadogCredentials(creds: DatadogCredentials): string {
  return JSON.stringify(creds);
}

function parseStoredDatadogCredentials(raw: string | undefined): Partial<DatadogCredentials> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const obj = parsed as Record<string, unknown>;
    return {
      apiKey: typeof obj.apiKey === "string" ? obj.apiKey : undefined,
      appKey: typeof obj.appKey === "string" ? obj.appKey : undefined,
      site: typeof obj.site === "string" ? obj.site : undefined,
    };
  } catch {
    return {};
  }
}

export interface ResolveDatadogCredentialsOptions {
  apiKey?: string;
  appKey?: string;
  site?: string;
  storedCredentials?: string;
}

// Same explicit-flag > env var > stored precedence every other connector in
// this CLI uses (see mcp-framework/walker.ts's resolveMcpToken, figma-
// comments.ts's resolveFigmaToken) -- applied per field, since Datadog
// needs three independent values rather than one token.
export function resolveDatadogCredentials(options: ResolveDatadogCredentialsOptions): DatadogCredentials {
  const stored = parseStoredDatadogCredentials(options.storedCredentials);
  const apiKey = options.apiKey ?? process.env.GNT_DATADOG_API_KEY ?? stored.apiKey;
  const appKey = options.appKey ?? process.env.GNT_DATADOG_APP_KEY ?? stored.appKey;
  const site = options.site ?? process.env.GNT_DATADOG_SITE ?? stored.site ?? DEFAULT_DATADOG_SITE;
  if (!apiKey || !appKey) throw new MissingDatadogCredentialsError();
  return { apiKey, appKey, site };
}

function apiBase(site: string): string {
  return `https://api.${site}`;
}

// Datadog's own web app URL for a notebook -- current product docs use
// this app.<site> host uniformly across every region (the primary sites
// and the additional regional ones alike). Used for provenance only; a
// wrong guess here would produce an inaccurate link, never a wrong read.
function notebookUrl(site: string, id: string): string {
  return `https://app.${site}/notebook/${id}`;
}

function authHeaders(creds: DatadogCredentials): Record<string, string> {
  return { "DD-API-KEY": creds.apiKey, "DD-APPLICATION-KEY": creds.appKey };
}

function describeFetchError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Best-effort read of Datadog's own error payload shape (`{ errors: [...] }`),
// falling back to a bare status code when the body isn't JSON or doesn't
// match. Never includes either credential -- both only ever travel in the
// request's own DD-API-KEY/DD-APPLICATION-KEY headers, never echoed into a
// message here.
async function describeErrorResponse(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const detail =
    body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).errors)
      ? ((body as Record<string, unknown>).errors as unknown[]).filter((e) => typeof e === "string").join("; ")
      : undefined;
  return detail ? `${res.status}: ${detail}` : `HTTP ${res.status}`;
}

// One real, kept-as-minimal-as-possible read used to validate a pasted API
// key + application key pair before either is written to disk -- see this
// file's own top-of-file "Scope control" section for why this is the one
// place the List Notebooks endpoint is ever called. count=1 keeps the
// response small; this connector reads nothing from the body at all, only
// the status code -- even the light metadata a listing call returns is
// never parsed here.
export async function validateDatadogCredentials(
  creds: DatadogCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(`${apiBase(creds.site)}/api/v1/notebooks?count=1&start=0`, {
      headers: authHeaders(creds),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DatadogApiError(`Couldn't reach Datadog: ${describeFetchError(err)}`);
  }
  if (!res.ok) {
    throw new DatadogApiError(`Datadog rejected those credentials (${await describeErrorResponse(res)})`);
  }
}

interface NotebookMarkdownDocument {
  name: string;
  markdownSections: string[];
}

// Reads exactly `attributes.name` and each markdown cell's `definition.text`
// off a raw notebook response -- see this file's own top-of-file "Field
// discipline" section for the full list of fields this deliberately never
// reads. Parses defensively (a couple of plausible shapes for where `data`/
// `cells`/`definition` live), same "drop what doesn't parse, never guess,
// never fail the run over one shape surprise" bias every walker in this
// directory already has -- this codebase has no live Datadog account to
// confirm the exact response shape against, so it's built off Datadog's
// own published API reference instead.
function extractNotebookDocument(raw: unknown): NotebookMarkdownDocument | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const data = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : root;
  const attributes =
    data.attributes && typeof data.attributes === "object" ? (data.attributes as Record<string, unknown>) : null;
  if (!attributes) return null;

  const name = typeof attributes.name === "string" ? attributes.name : "";

  const cellsRaw = Array.isArray(attributes.cells) ? attributes.cells : [];
  const markdownSections: string[] = [];
  for (const cell of cellsRaw) {
    if (!cell || typeof cell !== "object") continue;
    const cellObj = cell as Record<string, unknown>;
    const cellAttributes =
      cellObj.attributes && typeof cellObj.attributes === "object"
        ? (cellObj.attributes as Record<string, unknown>)
        : cellObj;
    const definition =
      cellAttributes.definition && typeof cellAttributes.definition === "object"
        ? (cellAttributes.definition as Record<string, unknown>)
        : null;
    if (!definition || definition.type !== "markdown") continue;
    if (typeof definition.text === "string" && definition.text.trim()) {
      markdownSections.push(definition.text.trim());
    }
  }

  if (!name && markdownSections.length === 0) return null;
  return { name, markdownSections };
}

function buildNotebookDocument(doc: NotebookMarkdownDocument): string {
  const heading = `# ${doc.name || "Untitled Datadog notebook"}`;
  return [heading, ...doc.markdownSections].filter(Boolean).join("\n\n");
}

async function fetchNotebook(id: string, creds: DatadogCredentials, fetchImpl: typeof fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`${apiBase(creds.site)}/api/v1/notebooks/${encodeURIComponent(id)}`, {
      headers: authHeaders(creds),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DatadogApiError(`Couldn't reach Datadog for notebook ${id}: ${describeFetchError(err)}`);
  }
  if (!res.ok) {
    throw new DatadogApiError(`Datadog notebook request failed for ${id} (${await describeErrorResponse(res)})`);
  }
  return res.json().catch(() => null);
}

export interface WalkDatadogNotebooksOptions {
  apiKey?: string;
  appKey?: string;
  site?: string;
  storedCredentials?: string;
  /** Which Datadog notebooks to read -- required; this walker never lists or discovers notebooks on its own, see this file's own "Scope control" section. */
  notebookIds: string[];
  /** Injectable seam for tests -- defaults to the real global fetch. */
  fetchImpl?: typeof fetch;
}

// Public walker: same shape every other prebrain walker exposes. The
// empty-notebookIds short-circuit stays here, ahead of resolving
// credentials, so an empty scope never makes a network call at all -- same
// behavior every other MCP-in/REST walker's own empty-scope short-circuit
// keeps.
//
// A notebook id that fails outright (bad credentials, not found, rate
// limit) throws DatadogApiError and aborts the rest of this walker's own
// run -- same granularity figma-comments.ts's own file-key loop already
// keeps (no per-id try/catch here either): commands/prebrain.ts's own
// try/catch around this walker turns that into a single "Datadog notebooks
// walker skipped: <message>" line, and the rest of `gnt prebrain` still
// completes. A malformed individual cell within an otherwise-successful
// notebook response is a different case -- extractNotebookDocument drops
// it and the rest of that notebook's markdown still comes through, same
// "skip the bad row, not the whole read" bias every parser in this
// directory already has.
export async function walkDatadogNotebooks(options: WalkDatadogNotebooksOptions): Promise<PrebrainChunk[]> {
  if (options.notebookIds.length === 0) return [];

  const creds = resolveDatadogCredentials({
    apiKey: options.apiKey,
    appKey: options.appKey,
    site: options.site,
    storedCredentials: options.storedCredentials,
  });
  const fetchImpl = options.fetchImpl ?? fetch;

  const chunks: PrebrainChunk[] = [];
  for (const id of options.notebookIds) {
    const raw = await fetchNotebook(id, creds, fetchImpl);
    const doc = extractNotebookDocument(raw);
    if (!doc) continue;

    const body = buildNotebookDocument(doc);
    if (!body.trim()) continue;

    const sourcePath = notebookUrl(creds.site, id);
    for (const chunk of chunkText(body)) {
      chunks.push({
        text: chunk.text,
        sourcePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        walker: "datadog-notebooks",
        looksLikeDecisionProse: classifyDecisionProse(chunk.text),
      });
    }
  }

  return chunks;
}

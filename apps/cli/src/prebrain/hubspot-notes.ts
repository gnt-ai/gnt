// Live-HubSpot notes client: reads a customer-
// scoped set of HubSpot Note engagements -- the note's own written text,
// nothing else -- as decision-prose candidates. Direct against HubSpot's
// own REST CRM API, not an MCP adapter: see "Why this isn't an MCP-in
// connector" below for the two official HubSpot MCP surfaces this task
// checked and why both were ruled out. Same "no framework, hand-kept field
// discipline" shape as ../figma-comments.ts and ../datadog-notebooks.ts --
// read those files' own doc comments alongside this one for the shared
// reasoning this file doesn't repeat.
//
// This is the highest records-leak-risk connector in the sprint (per the
// plan's own note): HubSpot's whole product is a CRM built around contact,
// company, and deal records, and its own APIs routinely let a caller ask
// for those records' properties alongside engagement content in the same
// request. Every design choice below exists to make that impossible here,
// not just unlikely -- see "Field discipline" for the specific guarantee
// and hubspot-notes.test.ts for the fixture that proves it.
//
// -- Why this isn't an MCP-in connector --
// HubSpot publishes two distinct official MCP offerings, both checked
// against HubSpot's own current developer documentation (developers.hubspot.com/mcp,
// developers.hubspot.com/changelog/mcp-server-beta) and its community
// support forum before this file was written, not assumed from memory:
//
// 1. A hosted remote server at mcp.hubspot.com. Its own docs state it
//    "enforces OAuth 2.1 with PKCE exclusively" -- there is no static,
//    customer-issued token this adapter could paste through the same
//    stdio-bridge pattern mcp-jira.ts/mcp-zoom.ts use for their own
//    OAuth-flavored vendors. An interactive browser OAuth flow for an
//    MCP-in walker is exactly the wall mcp-granola.ts already documents
//    hitting for Granola's own MCP server ("the honest limit on Granola's
//    OAuth-only auth model") -- this framework's connect flow has no
//    browser-redirect machinery, and building it belongs to framework
//    work, not a single adapter. Disqualified on transport, the same
//    category of reason datadog-notebooks.ts gives for Datadog's own
//    remote server.
// 2. A self-hosted @hubspot/mcp-server npm package, run locally via `npx`
//    and authenticated with a private app access token -- structurally the
//    right shape (a customer pastes a token, the whole read path stays on
//    their own device). What rules this one out is scope, not transport:
//    HubSpot's own docs describe it as one bundled tool surface across
//    "CRM objects: contacts, companies, deals, tickets, carts, products,
//    orders, line items, invoices, quotes, subscriptions, and segments"
//    plus "Engagements: calls, emails, meetings, notes, and tasks," with
//    read/write access, and name nine tools at launch without documenting
//    each one's exact input/output schema. A HubSpot community thread
//    titled "Remote MCP Server -- Notes Access & Auth Compatibility"
//    exists at the time of writing, itself a signal that notes access
//    through HubSpot's own MCP tooling isn't a settled, narrowly-scoped
//    question. Without a live HubSpot account and token to inspect the
//    package's actual tool definitions, there is no way to confirm this
//    server exposes a notes-only tool that can't also return a hydrated
//    contact/company/deal object the way a generic "get CRM object" tool
//    would -- exactly the mcp-sentry.ts-style indirection risk (a single
//    broad tool that satisfies the allowlist by name while defeating what
//    the allowlist exists to guarantee), except here it's the risk profile
//    of the entire adapter, not one sub-tool that can simply be excluded.
//    Given this is the sprint's own declared highest-leak-risk connector,
//    building on an unverifiable tool surface was the wrong call; a direct
//    REST client against HubSpot's own long-published, stable CRM v3/v4
//    API gives full, hand-auditable control over exactly which JSON keys
//    ever reach a chunk, which is what the rest of this file spends its
//    effort on.
//
// -- Notes: one object, shared by "engagement notes" and "deal notes" --
// HubSpot models a Note as one engagement type (crm/v3/objects/notes) that
// can be associated with a contact, a company, a deal, or a ticket. The
// plan's "engagement notes, deal notes" split isn't two different HubSpot
// objects -- it's two different ways of scoping which Notes this connector
// reads: notes attached to a deal that sits in an allowlisted pipeline
// ("deal notes"), and notes owned by a member of an allowlisted team,
// regardless of what they're attached to ("engagement notes"). Both paths
// read the exact same note shape through the exact same field-stripping
// function (extractNotes below).
//
// -- Playbook content: an honest scope cut, not a silent drop --
// The plan's own scope line also names "playbook content." HubSpot's
// developer documentation and its own community Ideas board (searched
// specifically for a Playbooks API before writing this file) agree there
// is no public API for creating, reading, or listing Playbooks -- it's a
// long-standing, frequently requested gap in HubSpot's own developer
// platform, not something this connector's scope decisions can route
// around. Same "a real gap, called out plainly rather than patched
// around" posture mcp-sentry.ts takes for get_issue_activity/
// get_issue_details: this connector reads engagement notes and deal notes
// only. If HubSpot ships a Playbooks read API later, that's a new read
// path for a future task, not something worth guessing at here.
//
// -- Endpoints, auth, and scope --
// A private app access token (self-serve, no OAuth app review, created in
// HubSpot's own Settings -> Integrations -> Private Apps), sent as
// `Authorization: Bearer <token>` on every request -- HubSpot's own
// documented bearer-token convention. Every endpoint this file calls is
// listed in HUBSPOT_ENDPOINTS below, the hand-kept equivalent of an MCP
// adapter's declared `reads` allowlist (see mcp-framework/README.md's
// "Declare your reads" section) -- a test asserts this is the exhaustive
// set and that none of it ever names a contact or company endpoint.
//
// Two independent scope dimensions, matching the plan's "Allowlist:
// pipelines/teams," at least one required:
//   - pipelineIds: deals in these pipelines are looked up by id only (no
//     deal properties requested at all -- see "Field discipline"), then
//     each deal's own associated note ids are listed and those notes' text
//     is read.
//   - teamIds: HubSpot owners (internal users, not customer contacts)
//     belonging to one of these teams are resolved by id, then notes owned
//     by that set of owners are searched and read directly.
// Same "customer supplies the exact list, this connector never
// auto-discovers" bias as every other adapter in this framework -- no
// pipeline or team is ever listed and offered up as a choice by this file
// itself.
//
// -- Field discipline --
// No framework here to strip undeclared fields structurally -- same
// hand-kept discipline figma-comments.ts and datadog-notebooks.ts document
// in their own "Field discipline" sections, applied here with extra care
// given this connector's own risk profile:
//   - extractNotes reads exactly two things off a raw note entry: its own
//     `id` and `properties.hs_note_body`. It has no branch that ever reads
//     `associations`, or any embedded `contact`/`company`/`deal` object a
//     note response might carry -- those keys are not merely unread, they
//     are never named in this function's code at all, so a future response
//     shape that embeds hydrated related-record data for convenience can't
//     leak through by accident the way a looser "spread everything except
//     a denylist" implementation could.
//   - extractOwners (used only to resolve team membership) reads exactly
//     `id` and `teams[].id` off a raw owner entry -- an owner's own name
//     and email (internal HubSpot user identity, not a customer record,
//     but still identity data with no reason to ever reach a chunk) are
//     never read.
//   - Deal search (searchDealIdsInPipeline) requests `properties: []` --
//     no deal property is ever requested from HubSpot at all, let alone
//     read out of the response. A deal's own id is not customer PII, the
//     same "internal database key used for addressing, not a record field"
//     status monday.com's item id and Jira's issue key already have in
//     this framework -- see PrebrainChunk's own doc comment in ../types.ts.
//   - Every note read (batch-read and search alike) requests
//     `properties: ["hs_note_body"]` only -- HubSpot's own v3 CRM API
//     honors a `properties` query/body parameter and returns only the
//     requested keys, so the wire response itself is already minimal; the
//     code-level restriction above is what holds even if that parameter
//     were ever ignored or a future response shape changed.
// hubspot-notes.test.ts proves this against a fixture shaped like a
// plausible "hydrated" HubSpot response -- a note carrying its own body
// text alongside an embedded contact object (email, phone, first/last
// name) and an embedded deal object (amount, dealstage, closedate) -- and
// checks the produced chunks for the complete absence of all of it.
//
// -- Honest limit on what's verified here --
// Like mcp-jira.ts and mcp-sentry.ts, this codebase has no live HubSpot
// account or private app token to test against, so the exact JSON shape
// each endpoint returns is not confirmed live -- it follows HubSpot's own
// published CRM v3/v4 API reference (developers.hubspot.com/docs/api-reference/...),
// the same "most plausible guess available, not a live-confirmed one"
// posture those two files already carry. Parsing throughout is
// deliberately defensive for the same reason: an entry that doesn't match
// the expected shape is dropped, never guessed at.
import { chunkText, classifyDecisionProse } from "./chunk.js";
import type { PrebrainChunk } from "./types.js";

export const HUBSPOT_API_BASE = "https://api.hubapi.com";

// The mcp-tokens.json key this connector's token is stored under (see
// ../credentials.ts's saveMcpToken/loadMcpToken) and the env var fallback.
export const HUBSPOT_TOKEN_ID = "hubspot";

const REQUEST_TIMEOUT_MS = 15_000;

// Seeds a first rulebook, not a mirror of a pipeline's or team's entire
// note history -- same "coarse, documented scope limit" reasoning as
// mcp-sentry.ts's MAX_ISSUES_PER_PROJECT / figma-comments.ts's
// MAX_THREADS_PER_FILE.
const MAX_DEALS_PER_PIPELINE = 50;
const MAX_NOTES_PER_DEAL = 20;
const MAX_NOTES_PER_TEAM = 100;
const MAX_OWNERS = 100;
const BATCH_READ_SIZE = 100;

// The exhaustive set of HubSpot REST endpoints this connector ever calls,
// exported so a test can assert none of them (or their own descriptions)
// ever names a contact or company endpoint, and that deal/note reads never
// request a property beyond what's documented here. See this file's own
// top-of-file "Endpoints, auth, and scope" section.
export const HUBSPOT_ENDPOINTS: readonly { path: string; description: string }[] = [
  {
    path: "GET /crm/v3/owners",
    description:
      "List owners and their team ids, to resolve which owners belong to an allowlisted team. Reads only " +
      "id and teams[].id -- never an owner's name or email. Also used as the connect-flow probe (limit=1).",
  },
  {
    path: "POST /crm/v3/objects/deals/search",
    description:
      "Find deal ids within an allowlisted pipeline. Requests properties: [] -- no deal property is ever " +
      "requested, let alone read; only each matching deal's own id.",
  },
  {
    path: "GET /crm/v4/objects/deals/{dealId}/associations/notes",
    description: "List the note ids associated with one deal. Reads only each association's toObjectId.",
  },
  {
    path: "POST /crm/v3/objects/notes/batch/read",
    description:
      "Batch-fetch note text by id for deal-associated notes, requesting properties: [\"hs_note_body\"] only.",
  },
  {
    path: "POST /crm/v3/objects/notes/search",
    description:
      "Find and read notes owned by an allowlisted team's members, requesting properties: [\"hs_note_body\"] " +
      "only -- same field discipline as the batch-read endpoint above.",
  },
];

export class MissingHubspotTokenError extends Error {
  constructor() {
    super("No HubSpot token found. Run `gnt connect hubspot`, pass --hubspot-token, or set GNT_HUBSPOT_TOKEN.");
    this.name = "MissingHubspotTokenError";
  }
}

export class HubspotApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubspotApiError";
  }
}

// Same explicit-token > env var > stored-token precedence every other
// connector in this CLI uses (see figma-comments.ts's resolveFigmaToken).
export function resolveHubspotToken(explicit: string | undefined, storedToken: string | undefined): string {
  const token = explicit ?? process.env.GNT_HUBSPOT_TOKEN ?? storedToken;
  if (!token) throw new MissingHubspotTokenError();
  return token;
}

function describeFetchError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Best-effort read of HubSpot's own error payload shape
// (`{ status, message, correlationId }`), falling back to a bare status
// code when the body isn't JSON or doesn't match. Never includes the
// token -- it only ever travels in the request's own Authorization header,
// never echoed into a message here.
async function describeErrorResponse(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const detail =
    body && typeof body === "object" && typeof (body as Record<string, unknown>).message === "string"
      ? (body as Record<string, unknown>).message
      : undefined;
  return detail ? `${res.status}: ${detail}` : `HTTP ${res.status}`;
}

async function hubspotRequest(
  method: "GET" | "POST",
  path: string,
  token: string,
  body: Record<string, unknown> | undefined,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`${HUBSPOT_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new HubspotApiError(`Couldn't reach HubSpot (${method} ${path}): ${describeFetchError(err)}`);
  }
  if (!res.ok) {
    throw new HubspotApiError(`HubSpot request failed (${method} ${path}): ${await describeErrorResponse(res)}`);
  }
  return res.json().catch(() => null);
}

// One real, side-effect-free read used to validate a pasted token before
// it's written to disk -- see commands/connect-hubspot.ts. Reuses the
// owners list (already declared above) at limit=1, the least-sensitive of
// this connector's own declared endpoints, rather than adding a new one
// just to probe.
export async function validateHubspotToken(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await hubspotRequest("GET", "/crm/v3/owners?limit=1", token, undefined, fetchImpl);
}

// Shared "read a string id out of each entry in a named array" extraction
// -- used for both deal search results (`results[].id`) and deal-to-note
// associations (`results[].toObjectId`). Malformed entries are dropped
// rather than guessed at, same bias every parser in this directory keeps.
function extractIds(raw: unknown, containerKey: string, idField: string): string[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as Record<string, unknown>)[containerKey];
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as Record<string, unknown>)[idField];
    if (typeof id === "string" && id) ids.push(id);
  }
  return ids;
}

interface OwnerTeams {
  ownerId: string;
  teamIds: string[];
}

// Reads exactly `id` and `teams[].id` off each raw owner entry -- see this
// file's own top-of-file "Field discipline" section for why an owner's own
// name and email are never read here, even though HubSpot's owners
// endpoint returns them.
function extractOwners(raw: unknown): OwnerTeams[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as Record<string, unknown>).results;
  if (!Array.isArray(list)) return [];

  const owners: OwnerTeams[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const ownerId = typeof obj.id === "string" ? obj.id : undefined;
    if (!ownerId) continue;

    const teamsRaw = Array.isArray(obj.teams) ? obj.teams : [];
    const teamIds: string[] = [];
    for (const team of teamsRaw) {
      if (team && typeof team === "object" && typeof (team as Record<string, unknown>).id === "string") {
        teamIds.push((team as Record<string, unknown>).id as string);
      }
    }
    owners.push({ ownerId, teamIds });
  }
  return owners;
}

interface HubspotNote {
  id: string;
  body: string;
}

// The single most load-bearing function in this file: reads exactly `id`
// and `properties.hs_note_body` off a raw note entry, and nothing else --
// see this file's own top-of-file "Field discipline" section. This
// function has no code path that ever reads `associations`, `contact`,
// `company`, or `deal` off an entry, so a raw response that embeds those
// (a fixture built to look like one, or a real HubSpot response that
// hydrates related objects for convenience) has nothing here that could
// pick it up.
function extractNotes(raw: unknown): HubspotNote[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as Record<string, unknown>).results;
  if (!Array.isArray(list)) return [];

  const notes: HubspotNote[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : undefined;
    if (!id) continue;

    const properties = obj.properties && typeof obj.properties === "object" ? (obj.properties as Record<string, unknown>) : null;
    const body = properties && typeof properties.hs_note_body === "string" ? properties.hs_note_body.trim() : "";
    if (!body) continue;

    notes.push({ id, body });
  }
  return notes;
}

async function searchDealIdsInPipeline(pipelineId: string, token: string, fetchImpl: typeof fetch): Promise<string[]> {
  const raw = await hubspotRequest(
    "POST",
    "/crm/v3/objects/deals/search",
    token,
    {
      filterGroups: [{ filters: [{ propertyName: "pipeline", operator: "EQ", value: pipelineId }] }],
      // No deal property is ever requested here -- see this file's own
      // "Field discipline" section. Only an id comes back.
      properties: [],
      limit: MAX_DEALS_PER_PIPELINE,
    },
    fetchImpl,
  );
  return extractIds(raw, "results", "id");
}

async function listDealNoteIds(dealId: string, token: string, fetchImpl: typeof fetch): Promise<string[]> {
  const raw = await hubspotRequest(
    "GET",
    `/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/notes?limit=${MAX_NOTES_PER_DEAL}`,
    token,
    undefined,
    fetchImpl,
  );
  return extractIds(raw, "results", "toObjectId").slice(0, MAX_NOTES_PER_DEAL);
}

async function batchReadNotes(noteIds: string[], token: string, fetchImpl: typeof fetch): Promise<HubspotNote[]> {
  const notes: HubspotNote[] = [];
  for (let i = 0; i < noteIds.length; i += BATCH_READ_SIZE) {
    const batch = noteIds.slice(i, i + BATCH_READ_SIZE);
    const raw = await hubspotRequest(
      "POST",
      "/crm/v3/objects/notes/batch/read",
      token,
      { properties: ["hs_note_body"], inputs: batch.map((id) => ({ id })) },
      fetchImpl,
    );
    notes.push(...extractNotes(raw));
  }
  return notes;
}

async function resolveOwnerIdsForTeams(teamIds: string[], token: string, fetchImpl: typeof fetch): Promise<string[]> {
  const raw = await hubspotRequest("GET", `/crm/v3/owners?limit=${MAX_OWNERS}`, token, undefined, fetchImpl);
  const owners = extractOwners(raw);
  const teamIdSet = new Set(teamIds);
  return owners.filter((owner) => owner.teamIds.some((id) => teamIdSet.has(id))).map((owner) => owner.ownerId);
}

async function searchNotesByOwners(ownerIds: string[], token: string, fetchImpl: typeof fetch): Promise<HubspotNote[]> {
  if (ownerIds.length === 0) return [];
  const raw = await hubspotRequest(
    "POST",
    "/crm/v3/objects/notes/search",
    token,
    {
      filterGroups: [{ filters: [{ propertyName: "hubspot_owner_id", operator: "IN", values: ownerIds }] }],
      properties: ["hs_note_body"],
      limit: MAX_NOTES_PER_TEAM,
    },
    fetchImpl,
  );
  return extractNotes(raw);
}

function buildNoteDocument(heading: string, body: string): string {
  return `# ${heading}\n\n${body}`;
}

function pushNoteChunks(chunks: PrebrainChunk[], heading: string, note: HubspotNote, sourcePath: string): void {
  const body = buildNoteDocument(heading, note.body);
  for (const chunk of chunkText(body)) {
    chunks.push({
      text: chunk.text,
      sourcePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      walker: "hubspot-notes",
      looksLikeDecisionProse: classifyDecisionProse(chunk.text),
    });
  }
}

export interface WalkHubspotNotesOptions {
  token?: string;
  storedToken?: string;
  /** Deal pipelines to read deal notes from -- at least one of pipelineIds/teamIds is required, see this file's own "Endpoints, auth, and scope" section. This walker never discovers pipelines on its own. */
  pipelineIds: string[];
  /** Teams whose members' notes to read, regardless of what the note is attached to -- see pipelineIds above. This walker never discovers teams on its own. */
  teamIds: string[];
  /** Injectable seam for tests -- defaults to the real global fetch. */
  fetchImpl?: typeof fetch;
}

// Public walker: same shape every other prebrain walker exposes. The
// empty-scope short-circuit stays here, ahead of resolving a token, so a
// run with neither pipelineIds nor teamIds never makes a network call at
// all -- same behavior every other REST/MCP-in walker's own empty-scope
// short-circuit keeps.
//
// A failure in either scope path (bad token, a pipeline/team that doesn't
// exist, a rate limit) throws HubspotApiError and aborts the rest of this
// walker's own run -- same granularity datadog-notebooks.ts's/
// figma-comments.ts's own loops keep (no per-id try/catch here either):
// commands/prebrain.ts's own try/catch around this walker turns that into
// a single "HubSpot notes walker skipped: <message>" line, and the rest of
// `gnt prebrain` still completes. A malformed individual note or owner
// entry within an otherwise-successful response is a different case --
// extractNotes/extractOwners drop it and the rest of that response's
// entries still come through, same "skip the bad row, not the whole read"
// bias every parser in this directory already has.
export async function walkHubspotNotes(options: WalkHubspotNotesOptions): Promise<PrebrainChunk[]> {
  if (options.pipelineIds.length === 0 && options.teamIds.length === 0) return [];

  const token = resolveHubspotToken(options.token, options.storedToken);
  const fetchImpl = options.fetchImpl ?? fetch;
  const chunks: PrebrainChunk[] = [];

  const seenDealNotes = new Set<string>();
  for (const pipelineId of options.pipelineIds) {
    const dealIds = await searchDealIdsInPipeline(pipelineId, token, fetchImpl);
    for (const dealId of dealIds) {
      const noteIds = await listDealNoteIds(dealId, token, fetchImpl);
      if (noteIds.length === 0) continue;

      const notes = await batchReadNotes(noteIds, token, fetchImpl);
      for (const note of notes) {
        const key = `${dealId}:${note.id}`;
        if (seenDealNotes.has(key)) continue;
        seenDealNotes.add(key);
        pushNoteChunks(chunks, "HubSpot deal note", note, `hubspot/deals/${dealId}/notes/${note.id}`);
      }
    }
  }

  if (options.teamIds.length > 0) {
    const ownerIds = await resolveOwnerIdsForTeams(options.teamIds, token, fetchImpl);
    const notes = await searchNotesByOwners(ownerIds, token, fetchImpl);
    for (const note of notes) {
      pushNoteChunks(chunks, "HubSpot engagement note", note, `hubspot/notes/${note.id}`);
    }
  }

  return chunks;
}

// Live-Granola adapter: reads meeting notes and
// verbatim transcripts from customer-chosen Granola folders through
// Granola's own official MCP server. Opt-in only: this walker only runs
// when `gnt prebrain --mcp-granola --granola-folders <id>` is passed (see
// commands/prebrain.ts) -- never by default, same as every other MCP-in
// walker.
//
// Since the connector-framework refactor this is a thin adapter, same
// shape as mcp-notion.ts/mcp-monday.ts: it declares its server, its
// read-only allowlist, and the fields it reads, then walks the folders
// it's given. The framework owns connecting, allowlist enforcement,
// stripping undeclared fields, chunking, closing, and skip-and-report on
// failure.
//
// This adapter also introduces the shared transcript chunker
// (../transcript-chunk.ts) -- see that file's own header comment for the
// speaker-turn and decision-moment heuristics it implements. The Zoom
// adapter and the meeting-export walkers are built to reuse it directly.
//
// -- Tool names: verified, not guessed --
// GRANOLA_READS below names get_meeting_transcript, get_meetings,
// list_meeting_folders, and list_meetings. These were checked two
// independent ways before being hardcoded: against Granola's own current
// help-center documentation (docs.granola.ai/help-center/sharing/integrations/mcp,
// fetched directly) and against a live Granola MCP session's actual tool
// schemas, both of which list exactly the same six read-only tools with
// exactly this naming. account_info and query_granola_meetings are
// deliberately NOT in this adapter's allowlist -- see the two comments
// below explaining why each is excluded, even though both are read-only.
//
// -- Read-only guarantee --
// GRANOLA_READS is the complete set of tools this adapter ever calls. The
// vendor's MCP surface exposes no write tools at all (Granola's own docs
// describe every tool it publishes as read/query-only), but this adapter
// still only ever calls the four declared here, the same "an exhaustive
// allowlist, not a live-advertised read/write label" discipline every
// other adapter in this framework applies.
//
// list_meeting_folders is declared and used only as the connect flow's
// validation probe (one real read before a credential is treated as
// working) -- the walk itself never calls it. Same reasoning
// mcp-monday.ts gives for not auto-discovering boards: the walk takes an
// explicit list of folder ids from the customer (--granola-folders,
// repeatable/comma-separated) rather than a source this adapter would
// otherwise have to trust to enumerate the customer's entire workspace.
//
// query_granola_meetings is excluded even though Granola's own docs
// describe it as read-only (a natural-language Q&A tool over meeting
// notes, with no mutation capability mentioned anywhere) -- it takes no
// folder-scoping parameter at all, so calling it would read across the
// customer's whole account regardless of which folders they allowlisted
// with --granola-folders. That's a direct conflict with the plan's own
// "Allowlist: folders/workspaces" scope for this connector, so it's left
// out on that basis, not a read-only concern.
//
// get_account_info is excluded because it returns account-level identity
// (the signed-in user's email and active workspace), not meeting-note
// content -- out of scope for a connector whose whole job is folder-scoped
// meeting content, never account metadata.
//
// -- Honest limit: Granola's MCP is hosted + OAuth-only, not a
// customer-run local server with a static token --
// Notion and monday.com both publish an official, customer-run,
// static-token-authenticated MCP server package a stdio client can spawn
// directly -- see mcp-notion.ts's/mcp-monday.ts's own doc comments.
// Granola does not: its ONLY official MCP surface is a hosted remote
// endpoint (https://mcp.granola.ai/mcp), and Granola's own docs are
// explicit that browser OAuth is the only supported authentication --
// "We currently only support authentication through browser OAuth. For
// other forms of authentication, please send feedback to hey@granola.so."
// Granola's separate REST API does support a pasted API key, but that is
// a different product surface, not MCP, and adapting it would mean this
// file hand-writing a local MCP server shim rather than being the "one
// adapter file plus fixtures" this framework promises.
//
// The practical, still-fully-local answer used elsewhere in the MCP
// ecosystem for exactly this situation (a stdio-only client that needs to
// reach an OAuth-only remote MCP server) is `mcp-remote`: a small local
// bridge process that performs the one-time browser OAuth handshake
// itself, caches the resulting session under the customer's own
// ~/.mcp-auth, and proxies stdio<->HTTPS from then on. `server` below
// spawns that bridge rather than a Granola-published package, because
// Granola doesn't publish an equivalent. This keeps the whole read path
// on the customer's device -- no gnt server involvement, the same
// invariant every other adapter here holds -- but it is a genuine,
// deliberate deviation from this framework's "customer pastes a static
// token" shape, not a limitation discovered late. THIS DESERVES EXPLICIT
// FOUNDER REVIEW BEFORE THIS CONNECTOR SHIPS: connect.ts's masked-token
// prompt (readMaskedToken) has no OAuth-flow variant, so
// `gnt connect granola-mcp`'s copy below asks the customer to type
// anything non-empty to proceed past that prompt, purely so the framework
// accepts a "token" to validate and store -- the value typed is never
// used as a credential (mcp-remote manages the real OAuth session on its
// own). That is a working but unusual UX for this one connector, flagged
// here, in the connect command's own file, and in this task's PR
// description, rather than shipped quietly. The clean long-term fix is a
// first-class OAuth-bridge connection mode in the framework itself
// (connect.ts/walker.ts), which is out of this single-adapter task's
// scope by this sprint's own rule against touching framework core files.
//
// One consequence, spelled out because it's easy to get wrong reading
// only the CLI surface: the McpInAdapter contract (types.ts) requires
// every adapter to declare a `tokenEnvVar` and to resolve some non-empty
// token before a walk runs (resolveMcpToken, walker.ts) -- both structural
// requirements this adapter cannot opt out of. `tokenEnvVar` below
// therefore still exists, and `server`'s own `token` parameter still gets
// resolved from it (or an explicit value, or the stored value `gnt
// connect granola-mcp` writes) by the framework before `server` ever
// runs -- but `server` ignores that resolved value entirely (`env: {}`),
// because none of those sources can ever be a real Granola credential:
// mcp-remote is the only thing that talks to Granola, and it authenticates
// with its own cached browser-OAuth session, not with anything this
// adapter passes it. That's why there is deliberately NO
// --granola-mcp-token CLI flag (see index.ts/commands/prebrain.ts) and why
// MissingGranolaMcpTokenError below only ever points at `gnt connect
// granola-mcp` -- surfacing GNT_GRANOLA_MCP_TOKEN as an equally valid
// alternative would be actively misleading (a customer could reasonably
// generate a real Granola REST API key, since one exists for Granola's
// separate REST product, set it, and believe it was doing something).
import { chunkTranscript } from "./transcript-chunk.js";
import { resolveMcpToken, runMcpInWalk } from "./mcp-framework/walker.js";
import type { McpAdapterContext, McpInAdapter, PrebrainChunk } from "./mcp-framework/types.js";
import type { McpToolClient } from "./mcp-connector.js";

const GRANOLA_READS = [
  { tool: "list_meeting_folders", kind: "structured", fields: ["folders", "id", "title", "name"] },
  { tool: "list_meetings", kind: "structured", fields: ["meetings", "id", "title", "name", "url"] },
  { tool: "get_meetings", kind: "structured", fields: ["meetings", "id", "title", "name", "summary", "notes", "url"] },
  { tool: "get_meeting_transcript", kind: "prose" },
] as const;

// Same "seed a first rulebook, don't mirror the whole workspace" reasoning
// as mcp-notion.ts's MAX_PAGES / mcp-monday.ts's MAX_ITEMS_PER_BOARD.
const MAX_MEETINGS_PER_FOLDER = 50;
// get_meetings' own documented limit: "Array of meeting UUIDs (max 10)".
const GET_MEETINGS_BATCH_SIZE = 10;

export class MissingGranolaMcpTokenError extends Error {
  constructor() {
    // Deliberately points at gnt connect granola-mcp only -- see this
    // file's own header comment for why there is no --granola-mcp-token
    // flag or GNT_GRANOLA_MCP_TOKEN env var to suggest here: neither can
    // ever function as a real Granola credential, so presenting them as
    // alternatives would mislead a customer into thinking one does.
    super("No Granola MCP connection found. Run `gnt connect granola-mcp` to sign in.");
    this.name = "MissingGranolaMcpTokenError";
  }
}

interface GranolaMeetingRef {
  id: string;
  title: string;
  url?: string;
}

interface GranolaMeetingDetail {
  notes: string;
}

// list_meetings' response is expected to be a JSON object with a
// `meetings` array (mirrors get_meetings' own plural naming) -- also
// accepts a bare array, same "try both shapes" defensiveness
// mcp-notion.ts's parseSearchResults applies, since this codebase has no
// live Granola workspace to confirm the exact shape against. A hit
// missing an id is dropped; title falls back to "name" (both declared)
// then a generic label, same fallback chain Notion's/monday's own parsers
// use.
function parseMeetingList(data: unknown): GranolaMeetingRef[] {
  const list: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).meetings)
      ? ((data as Record<string, unknown>).meetings as unknown[])
      : [];

  const refs: GranolaMeetingRef[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const id = obj.id;
    if (typeof id !== "string" || !id) continue;
    const title =
      (typeof obj.title === "string" && obj.title) || (typeof obj.name === "string" && obj.name) || "Untitled meeting";
    const url = typeof obj.url === "string" ? obj.url : undefined;
    refs.push({ id, title, url });
  }
  return refs;
}

// get_meetings' response is expected to be a JSON object with a
// `meetings` array, one entry per requested id, notes/summary text under
// one of a few plausible field names depending on server version, all
// declared in GRANOLA_READS. Deliberately does NOT read `attendees` --
// even though Granola's own docs say get_meetings returns attendee data,
// it is not declared in GRANOLA_READS, so the framework's field
// projection has already stripped it before this function ever runs; see
// mcp-granola.test.ts's declared-fields assertion for proof.
function parseMeetingDetails(data: unknown): Map<string, GranolaMeetingDetail> {
  const list: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).meetings)
      ? ((data as Record<string, unknown>).meetings as unknown[])
      : [];

  const details = new Map<string, GranolaMeetingDetail>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const id = obj.id;
    if (typeof id !== "string" || !id) continue;
    const notes = (typeof obj.notes === "string" && obj.notes) || (typeof obj.summary === "string" && obj.summary) || "";
    details.set(id, { notes });
  }
  return details;
}

function chunkIds<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

// Granola's own shape doesn't fit buildProseDocument's "prose body plus an
// optional Comments thread" assembly (document.ts) -- a meeting has a
// verbatim transcript AND Granola's own separate AI-written notes, and
// labeling the notes section "## Comments" (buildProseDocument's fixed
// heading) would mislabel provenance for whoever reviews a rule citing it
// later. The transcript is the primary body (it's the richest,
// turn-structured source the decision-moment heuristic actually works on);
// notes/summary is a secondary, honestly-labeled section, dropped
// entirely when empty, same "empty section is dropped" behavior
// buildProseDocument gives every other adapter.
function buildMeetingDocument(title: string, transcript: string, notes: string): string {
  return [`# ${title}`, transcript, notes ? `## Notes\n\n${notes}` : ""].filter(Boolean).join("\n\n");
}

async function walkFolder(ctx: McpAdapterContext, folderId: string): Promise<void> {
  const listing = await ctx.readStructured("list_meetings", { folder_id: folderId });
  const meetings = parseMeetingList(listing).slice(0, MAX_MEETINGS_PER_FOLDER);
  if (meetings.length === 0) return;

  for (const batch of chunkIds(meetings, GET_MEETINGS_BATCH_SIZE)) {
    let details = new Map<string, GranolaMeetingDetail>();
    try {
      details = parseMeetingDetails(await ctx.readStructured("get_meetings", { meeting_ids: batch.map((m) => m.id) }));
    } catch {
      // A batch this integration can list but can't fetch notes/summary
      // for (permissions, plan tier) still yields each meeting's
      // transcript below -- same "bonus content, not the point of the
      // walk" tolerance mcp-notion.ts's list-comments handling applies.
    }

    for (const meeting of batch) {
      let transcript = "";
      try {
        transcript = await ctx.readProse("get_meeting_transcript", { meeting_id: meeting.id });
      } catch {
        // get_meeting_transcript is documented as paid-plan-only -- a
        // free-tier connection, or one without transcript permission,
        // still yields whatever notes/summary content get_meetings gave
        // this meeting.
      }

      const notes = details.get(meeting.id)?.notes ?? "";
      const body = buildMeetingDocument(meeting.title, transcript.trim(), notes.trim());
      ctx.emitDocument({ body, sourcePath: meeting.url ?? `meetings/${meeting.id}` });
    }
  }
}

export interface GranolaWalkParams {
  folderIds: string[];
}

// The adapter object the framework runs and the registry lists.
export const granolaAdapter: McpInAdapter<GranolaWalkParams> = {
  id: "granola-mcp",
  walker: "mcp-granola",
  label: "Granola",
  tokenEnvVar: "GNT_GRANOLA_MCP_TOKEN",
  missingTokenError: () => new MissingGranolaMcpTokenError(),
  // See this file's own "Honest limit" section above for why this spawns
  // mcp-remote against Granola's hosted endpoint rather than a
  // Granola-published local server, and why `token` isn't used as a
  // credential here.
  server: () => ({
    label: "Granola",
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.granola.ai/mcp"],
    env: {},
  }),
  reads: GRANOLA_READS,
  chunker: chunkTranscript,
  probe: { tool: "list_meeting_folders", args: {} },
  async walk(ctx, { folderIds }) {
    for (const folderId of folderIds) {
      await walkFolder(ctx, folderId);
    }
  },
};

// The exported resolve helper stays for the prebrain barrel, mirroring
// resolveNotionMcpToken/resolveMondayMcpToken's shape for interface
// consistency, but note what it's actually resolving for Granola: not a
// credential (see this file's own header comment), just whatever
// placeholder value satisfies the framework's "a token must be resolved
// before a walk runs" contract (resolveMcpToken, walker.ts) -- explicit,
// then GNT_GRANOLA_MCP_TOKEN, then a stored token, else
// MissingGranolaMcpTokenError. None of the CLI/index.ts surface exposes a
// way to supply the explicit form for Granola; only `gnt connect
// granola-mcp`'s stored placeholder does, deliberately.
export function resolveGranolaMcpToken(explicit: string | undefined, storedToken: string | undefined): string {
  return resolveMcpToken(granolaAdapter, explicit, storedToken);
}

export interface WalkMcpGranolaOptions {
  // Not customer-facing -- there is no --granola-mcp-token CLI flag (see
  // this file's own header comment on why one would be misleading). Kept
  // here only for interface consistency with WalkMcpNotionOptions/
  // WalkMcpMondayOptions and for tests that want to hand the framework an
  // explicit placeholder directly; commands/prebrain.ts never sets it.
  token?: string;
  storedToken?: string;
  /** Which folders to read -- required; this walker never discovers folders on its own (see this file's own doc comment). */
  folderIds: string[];
  /** Injectable seam for tests -- defaults to a real stdio connection via mcp-remote. */
  connect?: (token: string) => Promise<McpToolClient>;
}

// Public walker: same signature commands/prebrain.ts already calls for
// mcp-notion/mcp-monday. The empty-folderIds short-circuit stays here,
// ahead of the framework runner, so an empty folder list never resolves a
// token or opens a connection.
export function walkMcpGranola(options: WalkMcpGranolaOptions): Promise<PrebrainChunk[]> {
  if (options.folderIds.length === 0) return Promise.resolve([]);
  return runMcpInWalk(granolaAdapter, {
    token: options.token,
    storedToken: options.storedToken,
    connect: options.connect,
    params: { folderIds: options.folderIds },
  });
}

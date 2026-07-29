// Live-Zoom adapter: reads recording transcripts
// from customer-chosen Zoom hosts, scoped to a date range, through Zoom's
// own official MCP server. Same framework shape as mcp-notion.ts/
// mcp-linear.ts/mcp-sentry.ts -- declare a server, a read-only allowlist,
// and a chunker, then walk. See this directory's mcp-framework/README.md
// for the contract this file implements.
//
// -- Tool names: verified two independent ways --
// Zoom publishes exactly nine MCP tools on its "Zoom" server (developers.zoom.us/docs/mcp/zoom/):
// search_meetings, recordings_list, get_recording_resource, get_meeting_assets,
// search_zoom, create_new_file_with_markdown, get_file_content,
// hub_create_file_from_content, hub_get_file_content. This set, with these
// exact names, is documented in Zoom's own GitHub org (github.com/zoom/skills
// and github.com/zoom/zoom-plugin, skills/zoom-mcp/SKILL.md), which also
// gives each tool's parameters and required OAuth scope. A separately
// published third-party Zoom MCP connector exposes the same nine names with
// matching descriptions and parameter shapes, corroborating the
// GitHub-published set rather than replacing it (see the "honest limit"
// paragraph below for what that corroboration does and doesn't confirm
// about the raw vendor endpoint this CLI actually connects to).
//
// -- Read-only guarantee, and why only two of the nine tools are declared --
// ZOOM_READS below is the complete set of tools this adapter ever calls:
// recordings_list and get_recording_resource. Every other tool on Zoom's
// server is deliberately excluded, not merely unused:
//   - search_meetings: a keyword/relevance search over meeting metadata, not
//     scoped by host in the same structural way recordings_list is (a plain
//     per-user listing) -- recordings_list already gives this adapter
//     everything it needs to find a host's recordings in a date range, so
//     adding a second, overlapping discovery tool would only widen the
//     allowlist for no read this connector needs.
//   - get_meeting_assets: read-only, but far broader than a transcript --
//     its own documented response includes whiteboards, Zoom Docs, an
//     agenda document, and a participant list alongside the recording. Any
//     one of those is out of this connector's "recording transcripts" scope
//     from the plan, and get_meeting_assets has no field-level way to ask
//     for the recording alone, so it is left off the allowlist entirely
//     rather than declared with a field set that tries to carve out just
//     the recording piece.
//   - search_zoom: searches Team Chat messages and Zoom Docs/notes -- a
//     different content domain than meeting recordings, out of scope.
//   - create_new_file_with_markdown / hub_create_file_from_content: write
//     tools (Zoom Docs and Team Chat file creation). Never declared, so the
//     framework refuses them even if a future edit tried to call one.
//   - get_file_content / hub_get_file_content: read Zoom Docs/hub file
//     content, not meeting recordings -- a different product surface this
//     connector has no reason to touch.
//
// -- Auth model: hosted-only remote MCP server, user OAuth, static-bearer
// paste through mcp-remote (same shape as mcp-linear.ts, not
// mcp-granola.ts) --
// Zoom's MCP server has no local, npx-runnable package a stdio client can
// spawn directly (unlike Notion's/monday.com's own official packages) --
// its only offering is a centrally hosted remote endpoint at
// https://mcp.zoom.us/mcp/zoom/streamable (confirmed against the same
// zoom/skills GitHub documentation cited above), requiring OAuth 2.0 with
// PKCE through a Zoom Marketplace "General App" (a Server-to-Server app is
// explicitly documented as the wrong app type for this). Unlike Granola,
// whose docs state browser OAuth is the ONLY supported authentication with
// no static-token alternative (see mcp-granola.ts's own "Honest limit"
// section), Zoom's own documented setup for a generic MCP client is:
// complete the authorization-code+PKCE exchange once (outside this CLI, via
// the customer's own Marketplace app) to obtain a user OAuth access token,
// then pass that token as a static `Authorization: Bearer <token>` header
// on every request -- functionally the same "customer obtains and pastes a
// token" shape mcp-linear.ts already uses for Linear's own hosted-remote-plus-
// mcp-remote-bridge server, just with the token itself coming from a
// one-time OAuth exchange instead of a Sentry-/Notion-style API key page.
// `server` below spawns `mcp-remote` against that endpoint with the pasted
// token in a static header, the same bridging pattern mcp-linear.ts's own
// doc comment explains in full (an env var, never an argv value, for the
// same "not visible in `ps`" reasoning connectStdioMcpServer's own comment
// gives).
//
// One honest difference from Linear's own token, flagged here rather than
// glossed over: a Linear personal API key is long-lived; a Zoom user OAuth
// access token obtained this way is short-lived (Zoom's standard OAuth
// access tokens expire in about an hour and are normally kept alive with a
// refresh token, which this static-paste flow has no way to use). A
// customer connecting this way will need to re-run `gnt connect zoom-mcp`
// with a freshly obtained access token periodically, not once and done --
// this is called out plainly in the connect command's own intro text
// (../commands/connect-zoom-mcp.ts) and in this task's PR description, not
// discovered later by a customer whose connection silently stops working.
//
// -- Honest limit on what's verified here --
// This codebase has no live Zoom account to connect through the raw
// mcp.zoom.us endpoint directly -- the third-party connector cited above
// wraps Zoom's server for a single-user consumer chat product, not the bare
// vendor endpoint this CLI's own mcp-remote bridge will talk to. That
// wrapper's own recordings_list tool schema takes no `userId` argument at
// all (it always lists "the connected account's own" recordings), while
// Zoom's own published skill docs list `userId` as a recordings_list
// parameter, matching the REST endpoint recordings_list is built on
// (`GET /users/{userId}/recordings`, where userId is a path segment, "me"
// by default). The most likely explanation is that the consumer wrapper
// hardcodes userId to the signed-in user and drops it from the schema it
// exposes to a model, while the raw server still accepts it -- but that is
// inference, not a confirmed fact about the raw endpoint, so `userId` is
// passed through here on the documented-parameter theory, with the
// response-side host check below (matchesHost) as a second, independent
// enforcement layer that does not depend on the request-side scoping
// actually being honored.
import { chunkTranscript } from "./transcript-chunk.js";
import { resolveMcpToken, runMcpInWalk } from "./mcp-framework/walker.js";
import type { McpAdapterContext, McpInAdapter, PrebrainChunk } from "./mcp-framework/types.js";
import type { McpToolClient } from "./mcp-connector.js";

const ZOOM_READS = [
  {
    tool: "recordings_list",
    kind: "structured",
    fields: ["meetings", "uuid", "id", "topic", "host_id", "host_email", "share_url", "recording_files", "play_url"],
  },
  // types="transcript" is passed on every call (see walkRecording below), so
  // in practice only the transcripts container ever comes back -- but the
  // field declaration is what actually enforces that a vendor response
  // carrying summaries/next_steps/play_urls alongside a transcript never
  // reaches this adapter's own code, regardless of whether the server
  // honors that argument. See mcp-zoom.test.ts for proof.
  { tool: "get_recording_resource", kind: "structured", fields: ["transcripts", "timeline", "text", "display_name"] },
] as const;

// Same "seed a first rulebook, don't mirror a host's entire recording
// history" reasoning as mcp-notion.ts's MAX_PAGES / mcp-monday.ts's
// MAX_ITEMS_PER_BOARD.
const MAX_RECORDINGS_PER_HOST = 50;

export class MissingZoomMcpTokenError extends Error {
  constructor() {
    super("No Zoom MCP token found. Run `gnt connect zoom-mcp`, pass --zoom-mcp-token, or set GNT_ZOOM_MCP_TOKEN.");
    this.name = "MissingZoomMcpTokenError";
  }
}

interface ZoomRecordingMeeting {
  uuid: string;
  topic: string;
  hostId?: string;
  hostEmail?: string;
  deepLink?: string;
}

// Shared "array, or {key: array}" extraction, the same defensive multi-shape
// handling mcp-linear.ts's own extractList applies -- copied rather than
// imported, since each adapter file keeps its own parsing local by this
// framework's own convention (see mcp-linear.ts's identical helper).
function extractList(data: unknown, containerKeys: readonly string[]): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  for (const key of containerKeys) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  return [];
}

// A deep link where the vendor gives one: share_url first (a real "open
// this recording" link when present), then the first recording file's own
// play_url as a fallback -- both fields Zoom's List Recordings REST API
// (which recordings_list is built on) documents, though neither is
// guaranteed present on every account/recording. Returns undefined rather
// than guessing at a URL shape when neither is there, same "vendor URL if
// we have it, stable id path if we don't" fallback mcp-granola.ts/
// mcp-linear.ts already use.
function firstDeepLink(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.share_url === "string" && obj.share_url) return obj.share_url;
  const files = Array.isArray(obj.recording_files) ? obj.recording_files : [];
  for (const file of files) {
    if (file && typeof file === "object") {
      const playUrl = (file as Record<string, unknown>).play_url;
      if (typeof playUrl === "string" && playUrl) return playUrl;
    }
  }
  return undefined;
}

// recordings_list's response is expected to be a JSON object with a
// `meetings` array (mirrors the REST List Recordings endpoint it's built
// on), also accepts a bare array -- same "try both shapes" defensiveness
// every other adapter's own parser applies. A hit missing a uuid/id is
// dropped.
function parseRecordingsList(data: unknown): ZoomRecordingMeeting[] {
  const list = extractList(data, ["meetings"]);
  const meetings: ZoomRecordingMeeting[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const uuid =
      (typeof obj.uuid === "string" && obj.uuid) ||
      (typeof obj.id === "string" && obj.id) ||
      (typeof obj.id === "number" && String(obj.id)) ||
      undefined;
    if (!uuid) continue;
    const topic = typeof obj.topic === "string" && obj.topic ? obj.topic : "Untitled recording";
    const hostId = typeof obj.host_id === "string" ? obj.host_id : undefined;
    const hostEmail = typeof obj.host_email === "string" ? obj.host_email : undefined;
    meetings.push({ uuid, topic, hostId, hostEmail, deepLink: firstDeepLink(obj) });
  }
  return meetings;
}

// Second, response-side enforcement of the host allowlist, independent of
// whether the `userId` argument passed to recordings_list actually scoped
// the request server-side (see this file's own "honest limit" section on
// why that isn't confirmed against the raw vendor endpoint). If the
// response carries a host_id or host_email, it must match the host this
// walk is currently scoped to. If the response carries neither (a shape
// this adapter's parser can't rule out), the recording is allowed through
// rather than silently dropped -- this check is a second layer on top of
// the request-side scope, not a replacement for it, so it doesn't fail
// closed on a field the vendor simply didn't return.
function matchesHost(meeting: ZoomRecordingMeeting, host: string): boolean {
  const needle = host.trim().toLowerCase();
  if (meeting.hostId && meeting.hostId.toLowerCase() === needle) return true;
  if (meeting.hostEmail && meeting.hostEmail.toLowerCase() === needle) return true;
  if (!meeting.hostId && !meeting.hostEmail) return true;
  return false;
}

interface TranscriptSegment {
  text: string;
  displayName: string | null;
}

// get_recording_resource's transcript comes back as a JSON timeline of
// caption-length segments ({text, display_name, ts, end_ts}), not the flat
// "Name: text" lines transcript-chunk.ts's own header comment documents as
// the shape Zoom's plain-text transcript download produces -- this is the
// live MCP tool's structured form of the same content, and it needs
// converting before it fits chunkTranscript's input shape. ts/end_ts are
// deliberately not declared in ZOOM_READS (unused here), so the framework
// has already stripped them before this function runs.
function extractTimeline(data: unknown): TranscriptSegment[] {
  if (!data || typeof data !== "object") return [];
  const transcripts = (data as Record<string, unknown>).transcripts;
  if (!Array.isArray(transcripts)) return [];

  const segments: TranscriptSegment[] = [];
  for (const clip of transcripts) {
    if (!clip || typeof clip !== "object") continue;
    const timeline = (clip as Record<string, unknown>).timeline;
    if (!Array.isArray(timeline)) continue;
    for (const entry of timeline) {
      if (!entry || typeof entry !== "object") continue;
      const obj = entry as Record<string, unknown>;
      const text = typeof obj.text === "string" ? obj.text.trim() : "";
      if (!text) continue;
      const displayName = typeof obj.display_name === "string" && obj.display_name.trim() ? obj.display_name.trim() : null;
      segments.push({ text, displayName });
    }
  }
  return segments;
}

// Converts a caption timeline into transcript-chunk.ts's inline
// "Name: text" turn shape: consecutive segments from the same speaker are
// merged into one turn (a caption track splits one person's continuous
// speech into many short, sub-sentence entries; merging them is what lets
// parseSpeakerTurns see one real turn instead of dozens of one-line
// fragments), separated by a blank line from the next speaker's turn. A
// segment with no display_name becomes its own unattributed turn, the same
// graceful degradation transcript-chunk.ts documents for content with no
// speaker markup at all. This is the "light adaptation" this connector's
// own task called for -- the shared chunker itself (transcript-chunk.ts) is
// unchanged.
//
// One inherited limit worth naming: transcript-chunk.ts's SPEAKER_INLINE_PATTERN
// requires a display_name that looks like a person's name (capitalized
// words) to be recognized as a speaker header at all. Zoom's display_name
// is whatever the participant's account or guest join screen set --
// unlike Granola's meeting-attendee list, it can be a room/device name, an
// all-lowercase guest label, or an email address, none of which match that
// pattern. A segment like that degrades to being folded into the previous
// speaker's turn (if one exists) or its own unattributed turn, per
// transcript-chunk.ts's own documented fallback -- content is never lost,
// but attribution can be, which is the same disclaimer that heuristic
// already carries for every caller, not a defect introduced here.
function renderTranscript(data: unknown): string {
  const segments = extractTimeline(data);
  const blocks: string[] = [];
  let speaker: string | null = null;
  let pending: string[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    const joined = pending.join(" ");
    blocks.push(speaker ? `${speaker}: ${joined}` : joined);
    pending = [];
  };

  for (const segment of segments) {
    if (segment.displayName === speaker) {
      pending.push(segment.text);
    } else {
      flush();
      speaker = segment.displayName;
      pending = [segment.text];
    }
  }
  flush();

  return blocks.join("\n\n");
}

async function walkRecording(ctx: McpAdapterContext, meeting: ZoomRecordingMeeting): Promise<void> {
  let transcript = "";
  try {
    const resource = await ctx.readStructured("get_recording_resource", { meetingId: meeting.uuid, types: "transcript" });
    transcript = renderTranscript(resource).trim();
  } catch {
    // No transcript for this recording (still processing, transcript not
    // enabled, or no permission on this one) -- nothing else this adapter
    // reads for a recording, so there's nothing to emit for it. Other
    // recordings for this host still get walked.
    return;
  }
  if (!transcript) return;

  const body = `# ${meeting.topic}\n\n${transcript}`;
  ctx.emitDocument({ body, sourcePath: meeting.deepLink ?? `recordings/${meeting.uuid}` });
}

// recordings_list is this walk's primary discovery call, deliberately NOT
// caught here -- same "primary listing call propagates, only secondary/
// bonus reads are caught per item" split mcp-granola.ts's walkFolder (its
// own list_meetings) and mcp-linear.ts's walkIssuesInScope (its own
// list_issues) already establish. This matters specifically for this
// connector: the token-expiry caveat in this file's own "Auth model"
// section means a stale token fails recordings_list identically for every
// host, not just one, so letting it propagate (through runMcpInWalk to
// commands/prebrain.ts's own catch, which reports "Zoom MCP walker
// skipped: ...") is what actually surfaces that failure to the customer,
// rather than the whole run quietly returning zero chunks with no
// explanation. get_recording_resource below is the bonus-shaped read
// (a single recording that's still processing or lacks a transcript
// shouldn't cost every other recording), so that one keeps its own
// per-recording try/catch, same as mcp-granola.ts's own get_meeting_transcript.
async function walkHost(ctx: McpAdapterContext, host: string, from: string | undefined, to: string | undefined): Promise<void> {
  const listing = await ctx.readStructured("recordings_list", {
    userId: host,
    from,
    to,
    page_size: MAX_RECORDINGS_PER_HOST,
  });
  // The slice is deliberately re-applied after filtering, even though
  // page_size already asked the server to cap the page at
  // MAX_RECORDINGS_PER_HOST: matchesHost can only ever narrow the list, and
  // a vendor that ignores page_size (or a future edit that widens
  // matchesHost) should still hit this cap, not silently walk more than the
  // "seed a first rulebook" budget every other adapter's own MAX_* applies.
  const meetings = parseRecordingsList(listing)
    .filter((meeting) => matchesHost(meeting, host))
    .slice(0, MAX_RECORDINGS_PER_HOST);

  for (const meeting of meetings) {
    await walkRecording(ctx, meeting);
  }
}

export interface ZoomWalkParams {
  hosts: string[];
  from?: string;
  to?: string;
}

// The adapter object the framework runs and the registry lists.
export const zoomAdapter: McpInAdapter<ZoomWalkParams> = {
  id: "zoom-mcp",
  walker: "mcp-zoom",
  label: "Zoom",
  tokenEnvVar: "GNT_ZOOM_MCP_TOKEN",
  missingTokenError: () => new MissingZoomMcpTokenError(),
  // See this file's own "Auth model" section above for why this spawns
  // mcp-remote with a static bearer header against Zoom's hosted endpoint,
  // the same bridging shape mcp-linear.ts uses for Linear.
  server: (token) => ({
    label: "Zoom",
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.zoom.us/mcp/zoom/streamable", "--header", "Authorization:${ZOOM_MCP_AUTH_HEADER}"],
    env: { ZOOM_MCP_AUTH_HEADER: `Bearer ${token}` },
  }),
  reads: ZOOM_READS,
  chunker: chunkTranscript,
  probe: { tool: "recordings_list", args: { page_size: 1 } },
  async walk(ctx, { hosts, from, to }) {
    for (const host of hosts) {
      await walkHost(ctx, host, from, to);
    }
  },
};

// The exported resolve helper stays for the prebrain barrel -- delegates to
// the framework's shared precedence (explicit token, then GNT_ZOOM_MCP_TOKEN,
// then a stored token, else MissingZoomMcpTokenError).
export function resolveZoomMcpToken(explicit: string | undefined, storedToken: string | undefined): string {
  return resolveMcpToken(zoomAdapter, explicit, storedToken);
}

export interface WalkMcpZoomOptions {
  token?: string;
  storedToken?: string;
  /** Which hosts to read recordings from -- required; this walker never discovers hosts on its own, same reasoning as mcp-monday.ts's boardIds. */
  hosts: string[];
  /** recordings_list date-range narrowing, Zoom's own "yyyy-mm-dd" format. Both optional -- recordings_list itself defaults to just the current day when neither is passed, so an unscoped call is never a full-history pull. */
  from?: string;
  to?: string;
  /** Injectable seam for tests -- defaults to a real stdio connection through the mcp-remote bridge. */
  connect?: (token: string) => Promise<McpToolClient>;
}

// Public walker: the same shape commands/prebrain.ts already expects from
// the other MCP-in walkers. The empty-hosts short-circuit mirrors
// mcp-monday.ts's empty-boardIds one -- no host is known with nothing to
// read, so nothing resolves a token or opens a connection.
export function walkMcpZoom(options: WalkMcpZoomOptions): Promise<PrebrainChunk[]> {
  if (options.hosts.length === 0) return Promise.resolve([]);
  return runMcpInWalk(zoomAdapter, {
    token: options.token,
    storedToken: options.storedToken,
    connect: options.connect,
    params: { hosts: options.hosts, from: options.from, to: options.to },
  });
}

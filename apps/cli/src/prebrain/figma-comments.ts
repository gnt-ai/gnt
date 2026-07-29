// Live-Figma comments client: reads comment
// threads on customer-chosen Figma files -- a comment's own message text
// and the reply text below it -- as decision-prose candidates. Direct
// against Figma's own REST API, not an MCP adapter: no child process is
// spawned, no third-party package is installed, and none of the
// mcp-framework's own machinery (stdio transport, tool-call allowlist,
// declared-field stripping) applies, because none of it exists in this
// read path. This file owns its own field discipline instead -- see below.
//
// -- Why this replaces the earlier MCP-wrapper connector --
// An earlier version of this connector spawned a community npm package,
// @thirdstrandstudio/mcp-figma, as a local MCP server wrapping this exact
// REST endpoint. That put a customer's Figma personal access token through
// an unaudited third party's code for no reason a direct HTTPS client to
// Figma's own stable, documented endpoint doesn't already solve more
// simply and more auditably. This file is that direct client.
//
// Figma's own official MCP server (the Dev Mode MCP server) is a separate
// question and still doesn't change this: its whole tool surface is
// design-to-code, asset export, and design-system tooling (get_design_
// context, get_metadata, get_screenshot, get_variable_defs, and the rest)
// -- nothing in it reads a file's or a FigJam board's comments, so there
// is no vendor-official comment-reading tool to spawn even if this
// connector wanted an MCP shape.
//
// -- Endpoint, auth, and response shape --
// GET https://api.figma.com/v1/files/:file_key/comments, a personal access
// token in an X-Figma-Token header. Both confirmed against Figma's own
// published OpenAPI spec (github.com/figma/rest-api-spec): the endpoint's
// `security` block names `PersonalAccessToken`, and that scheme's own
// definition is `{ type: apiKey, name: X-Figma-Token, in: header }`. The
// response is `{ comments: Comment[] }`, no pagination. A Comment's full
// documented shape is id, client_meta (canvas/frame position), file_key,
// parent_id, user (id/handle/img_url -- the commenter's identity and
// avatar), created_at, resolved_at, message, order_id, and reactions
// (each of which carries its own user). Figma's postComment endpoint docs
// additionally confirm a reply thread is exactly one level deep: "This
// must be a root comment. You cannot reply to other replies (a comment
// that has a parent_id)." -- so grouping a flat list by parent_id, with no
// recursion, threads it correctly.
//
// GET https://api.figma.com/v1/me (same PersonalAccessToken auth, no file
// key needed) is this connector's connect-flow validation probe -- the
// least-destructive real read available: it proves a token is live
// without touching any file's content at all.
//
// -- Field discipline --
// There's no framework here to strip undeclared fields structurally (see
// mcp-framework/fields.ts's own doc comment for what that guarantee looks
// like when one exists) -- this file keeps the same discipline by hand.
// extractComment below reads exactly `id`, `message`, and `parent_id` off
// each raw comment object and nothing else: `user` (a commenter's handle,
// avatar URL, and stable id), `client_meta` (canvas position), `reactions`
// (which carries its own `user`), `created_at`, `resolved_at`, `order_id`,
// and the per-comment `file_key` are never read into a variable and never
// reach a chunk. figma-comments.test.ts proves this against a fixture
// shaped like Figma's real response, including a full commenter user
// object, and checks the produced chunks for its absence.
//
// No file name is ever fetched or attached to a chunk's provenance either
// -- the comments endpoint doesn't return one, and fetching it would mean
// a second call to a files endpoint this connector has no reason to make.
// A chunk's sourcePath is `figma/files/<file-key>/comments/<root-comment-
// id>` instead, the same "stable id path over a call this connector
// doesn't otherwise need" choice mcp-monday.ts already makes for its own
// item address.
import { chunkText, classifyDecisionProse } from "./chunk.js";
import type { PrebrainChunk } from "./types.js";

export const FIGMA_API_BASE = "https://api.figma.com";

// The mcp-tokens.json key this connector's token is stored under (see
// ../credentials.ts's saveMcpToken/loadMcpToken) and the env var fallback.
// Exported so commands/connect-figma.ts and commands/prebrain.ts both use
// this exact string rather than each hand-writing "figma" and risking a
// silent mismatch.
export const FIGMA_TOKEN_ID = "figma";

const REQUEST_TIMEOUT_MS = 15_000;

// Seeds a first rulebook, not a mirror of a file's entire comment history
// -- same "coarse, documented scope limit" reasoning as mcp-notion.ts's
// MAX_PAGES / mcp-monday.ts's MAX_ITEMS_PER_BOARD.
const MAX_THREADS_PER_FILE = 100;

export class MissingFigmaTokenError extends Error {
  constructor() {
    super("No Figma token found. Run `gnt connect figma`, pass --figma-token, or set GNT_FIGMA_TOKEN.");
    this.name = "MissingFigmaTokenError";
  }
}

export class FigmaApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FigmaApiError";
  }
}

// Same explicit-token > env var > stored-token precedence every other
// connector in this CLI uses (see mcp-framework/walker.ts's
// resolveMcpToken, extraction/cloud.ts's resolveCloudApiKey).
export function resolveFigmaToken(explicit: string | undefined, storedToken: string | undefined): string {
  const token = explicit ?? process.env.GNT_FIGMA_TOKEN ?? storedToken;
  if (!token) throw new MissingFigmaTokenError();
  return token;
}

interface FigmaCommentRecord {
  id: string;
  message: string;
  /** null for a root comment; the root's own id for a reply. Figma's comment model is one level deep -- see this file's own top-of-file comment. */
  parentId: string | null;
}

// Reads exactly id/message/parent_id off a raw comment object -- see this
// file's own top-of-file doc comment for the full list of fields Figma's
// API actually returns and why the rest are never touched here. An entry
// missing an id, or whose message is missing/blank, is dropped rather than
// guessed at -- same "malformed input is skipped, not fatal" bias every
// walker in this directory already has.
function extractComment(raw: unknown): FigmaCommentRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const id = obj.id;
  if (typeof id !== "string" || !id) return null;

  const message = obj.message;
  if (typeof message !== "string" || !message.trim()) return null;

  const parentRaw = obj.parent_id;
  const parentId = typeof parentRaw === "string" && parentRaw ? parentRaw : null;

  return { id, message: message.trim(), parentId };
}

function extractComments(data: unknown): FigmaCommentRecord[] {
  const list =
    data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).comments)
      ? ((data as Record<string, unknown>).comments as unknown[])
      : [];

  const comments: FigmaCommentRecord[] = [];
  for (const entry of list) {
    const parsed = extractComment(entry);
    if (parsed) comments.push(parsed);
  }
  return comments;
}

interface CommentThread {
  rootId: string;
  root: FigmaCommentRecord;
  replies: FigmaCommentRecord[];
}

// Groups a file's flat comment list into threads keyed by root comment id,
// in the order roots first appear. One pass is enough: Figma's own API
// refuses a reply to a reply (see this file's own top-of-file comment), so
// parentId is never more than one level deep. A reply whose parent isn't a
// root comment in this same response (the root landed outside
// MAX_THREADS_PER_FILE, or a shape this parse didn't expect) is dropped
// rather than guessed at.
function groupThreads(comments: FigmaCommentRecord[]): CommentThread[] {
  const threads = new Map<string, CommentThread>();
  for (const comment of comments) {
    if (comment.parentId === null) threads.set(comment.id, { rootId: comment.id, root: comment, replies: [] });
  }
  for (const comment of comments) {
    if (comment.parentId === null) continue;
    threads.get(comment.parentId)?.replies.push(comment);
  }
  return [...threads.values()];
}

function threadSourcePath(fileKey: string, rootId: string): string {
  return `figma/files/${fileKey}/comments/${rootId}`;
}

// The document body a thread becomes before chunking: a heading naming the
// file, the root comment's own message, then any replies under their own
// heading. Written locally rather than importing mcp-framework/document.ts's
// buildProseDocument -- this walker doesn't run through the mcp-framework
// at all (see this file's own top-of-file comment), so it doesn't borrow
// from it either, even for a small formatting helper.
function buildThreadDocument(fileKey: string, thread: CommentThread): string {
  const repliesText = thread.replies.map((reply) => reply.message).join("\n\n");
  return [`# Figma comment in ${fileKey}`, thread.root.message, repliesText ? `## Replies\n\n${repliesText}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

function describeFetchError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Best-effort read of Figma's own error payload shape ({ status, err }),
// falling back to a bare status code when the body isn't JSON or doesn't
// match. Never includes the token -- the token only ever travels in the
// request's own X-Figma-Token header, never echoed into a message here.
async function describeErrorResponse(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const detail =
    body && typeof body === "object" && typeof (body as Record<string, unknown>).err === "string"
      ? (body as Record<string, unknown>).err
      : undefined;
  return detail ? `${res.status}: ${detail}` : `HTTP ${res.status}`;
}

async function fetchFileComments(fileKey: string, token: string, fetchImpl: typeof fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`${FIGMA_API_BASE}/v1/files/${encodeURIComponent(fileKey)}/comments`, {
      headers: { "X-Figma-Token": token },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new FigmaApiError(`Couldn't reach Figma for file ${fileKey}: ${describeFetchError(err)}`);
  }

  if (!res.ok) {
    throw new FigmaApiError(`Figma comments request failed for file ${fileKey} (${await describeErrorResponse(res)})`);
  }

  return res.json().catch(() => null);
}

// One real, side-effect-free read used to validate a pasted token before
// it's written to disk (see commands/connect-figma.ts) -- GET /v1/me needs
// no file key and reads nothing about any file's content, the least-
// destructive live check this API offers. Throws FigmaApiError on
// anything other than a 200.
export async function validateFigmaToken(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(`${FIGMA_API_BASE}/v1/me`, {
      headers: { "X-Figma-Token": token },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new FigmaApiError(`Couldn't reach Figma: ${describeFetchError(err)}`);
  }

  if (!res.ok) {
    throw new FigmaApiError(`Figma rejected that token (${await describeErrorResponse(res)})`);
  }
}

export interface WalkFigmaCommentsOptions {
  token?: string;
  storedToken?: string;
  /** Which Figma files to read comments from -- required; this walker never discovers files or projects on its own, same reasoning mcp-monday.ts documents for not auto-discovering boards -- there is no read here that could safely list them. */
  fileKeys: string[];
  /** Injectable seam for tests -- defaults to the real global fetch. */
  fetchImpl?: typeof fetch;
}

// Public walker: same shape every other prebrain walker exposes (a plain
// async function returning PrebrainChunk[]). The empty-fileKeys
// short-circuit stays here, ahead of resolving a token, so an empty file
// list never makes a network call at all -- same behavior
// walkMcpMonday/walkMcpFigma's own empty-scope short-circuits keep.
//
// A file key that fails outright (bad token, file not found, rate limit)
// throws FigmaApiError and aborts the rest of this walker's own run --
// same granularity mcp-monday.ts's own board loop already keeps (no
// per-board try/catch there either): commands/prebrain.ts's own
// try/catch around this walker turns that into a single "Figma comments
// walker skipped: <message>" line and the rest of `gnt prebrain` (repo
// scan, docs, every other source) still completes. A malformed individual
// comment within an otherwise-successful response is a different case --
// extractComment drops it and the rest of that file's comments still come
// through, same "skip the bad row, not the whole read" bias every parser
// in this directory already has.
export async function walkFigmaComments(options: WalkFigmaCommentsOptions): Promise<PrebrainChunk[]> {
  if (options.fileKeys.length === 0) return [];

  const token = resolveFigmaToken(options.token, options.storedToken);
  const fetchImpl = options.fetchImpl ?? fetch;

  const chunks: PrebrainChunk[] = [];
  for (const fileKey of options.fileKeys) {
    const data = await fetchFileComments(fileKey, token, fetchImpl);
    const threads = groupThreads(extractComments(data)).slice(0, MAX_THREADS_PER_FILE);

    for (const thread of threads) {
      const body = buildThreadDocument(fileKey, thread);
      if (!body.trim()) continue;

      const sourcePath = threadSourcePath(fileKey, thread.rootId);
      for (const chunk of chunkText(body)) {
        chunks.push({
          text: chunk.text,
          sourcePath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          walker: "figma-comments",
          looksLikeDecisionProse: classifyDecisionProse(chunk.text),
        });
      }
    }
  }

  return chunks;
}

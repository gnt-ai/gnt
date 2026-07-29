// Live-GitLab threads client: reads merge request
// discussion threads and issue discussion threads on a customer-chosen
// project as decision-prose candidates. Direct against GitLab's own REST
// API, not an MCP adapter -- see "Why this isn't an MCP-in connector" below
// -- so this file owns its own field discipline by hand, same "no framework
// here" shape as ../figma-comments.ts and ../datadog-notebooks.ts. Read
// those two files' own doc comments alongside this one for the shared
// reasoning this file doesn't repeat.
//
// -- Why this isn't an MCP-in connector --
// GitLab does publish its own MCP server (docs.gitlab.com/user/model_context_
// protocol/mcp_server/), currently Beta as of GitLab 18.6, but its auth model
// is OAuth 2.0 Dynamic Client Registration -- the AI tool registers itself as
// an OAuth application against the customer's own GitLab instance and walks
// an interactive authorization flow, not a plain customer-pasted bearer
// token. That's the same category of transport mismatch mcp-notion.ts's own
// doc comment already rejected for Notion's hosted endpoint: standing up a
// dynamic OAuth client registration flow would put gnt's own infrastructure
// in the read path, which this framework's whole "customer pastes a token,
// the read stays on their own device" model is built to avoid. It's also
// still Beta, a materially less stable foundation than GitLab's own REST API,
// which has been stable for years. The plan's own task text specifies the
// intended auth shape directly -- "a customer-supplied project access token,
// read_api scope" -- which is exactly a static bearer credential against the
// plain REST API, the same shape figma-comments.ts already uses for Figma's
// personal access token. A direct REST client is what that auth model
// actually calls for, not either of GitLab's own MCP transports.
//
// -- Endpoints, auth, and response shape --
// Confirmed against GitLab's own published REST API reference
// (docs.gitlab.com/api/discussions/, /api/merge_requests/, /api/issues/,
// /api/notes/, /security/tokens/access_token_scopes/), not assumed from
// memory, per this sprint's standing "verify at build time" rule.
//
// GET /projects/:id/merge_requests/:merge_request_iid/discussions and
// GET /projects/:id/issues/:issue_iid/discussions both return a bare JSON
// array of Discussion objects: `{ id, individual_note, notes: [Note, ...] }`.
// A Note's documented shape is id, type ("DiscussionNote"/"DiffNote"/null),
// body, author (id/name/username/state/avatar_url/web_url), created_at,
// updated_at, system (boolean), noteable_id, noteable_type, project_id,
// resolvable, and (merge requests only) resolved/resolved_by/resolved_at. A
// DiffNote additionally carries a `position` object (file paths, line
// numbers, diff SHAs) locating the comment against the diff -- never the
// diff's own line content, just where the comment attaches.
//
// GET /projects/:id/merge_requests and GET /projects/:id/issues (list, no
// iid) each return a bare JSON array of full MR/issue objects -- the list
// response already carries each item's own title, description, and web_url
// in full, no separate per-item detail call needed the way Jira's
// getJiraIssue is (see mcp-jira.ts's own doc comment for that contrast).
//
// Auth is a single PRIVATE-TOKEN header carrying a personal or project
// access token (GitLab's own recommended header; Authorization: Bearer is
// also documented and would work, PRIVATE-TOKEN is used here since it's the
// one GitLab's own docs recommend). The read_api scope the plan specifies
// is real and documented (docs.gitlab.com/security/tokens/access_token_
// scopes/): "read access to the API", supported by both personal and
// project access tokens. GET /user (no project needed) is this connector's
// connect-flow validation probe -- the same "least-destructive live check
// available, no project scope needed yet" role Figma's GET /v1/me and
// Linear's list_teams play for their own connect flows.
//
// -- Content scope: threads, never the diff or issue metadata --
// This connector calls exactly four endpoint shapes, all listed in
// GITLAB_ENDPOINTS below, and never a diff/changes/commits endpoint at all
// -- not merely unread, there is no code path from this file to one. A
// DiffNote's own `position` field (see above) is never read either, for the
// same reason: it locates a comment against a diff, and reading it would
// start pulling file paths and line numbers into what's supposed to be
// prose-only content. From an MR/issue's own list entry, only iid, title,
// description, and web_url are ever read -- labels, assignee, milestone,
// state, approvals, pipeline/merge status, and every other structured field
// GitLab's own object carries are walked past and never touched, the same
// "title/description only, nothing past that" line mcp-jira.ts's own doc
// comment draws for Jira's issue fields.
//
// -- Field discipline: notes --
// parseDiscussionNotes below reads exactly one field off each note --
// `body` -- and uses `system` only as a boolean gate to skip a note
// entirely, never carrying its value into a chunk. A system note (GitLab's
// own automated audit trail -- "changed the description", "assigned to
// @user", "mentioned in commit ...") is dropped outright rather than
// treated as decision-prose: it's machine-generated activity logging, not
// something a person wrote, the same category of content Sentry's own
// adapter never reads captions of. `author`, `created_at`/`updated_at`,
// `noteable_id`/`noteable_type`, `project_id`, `resolvable`, and (merge
// requests only) `resolved`/`resolved_by`/`resolved_at` are never read into
// a variable, let alone a chunk -- gitlab-threads.test.ts proves this
// against a fixture shaped like GitLab's real response, including a full
// author object and a resolved merge-request thread, and checks the
// produced chunks for their absence.
//
// One deliberate call worth naming: the plan's own task text raised
// resolved/unresolved thread state as a candidate reason this connector
// might need document-assembly logic beyond what Linear/Jira built (see
// "Chunking" below). It doesn't -- this connector treats every discussion
// the same regardless of resolved state, the same choice figma-comments.ts
// already makes for its own `resolved_at` field. Whether a thread is closed
// out has no bearing on whether what was decided in it is worth extracting.
//
// -- Chunking: does Linear/Jira's "no dedicated chunker" call hold here? --
// Yes, and for a simpler reason than either of them needed. Linear's
// list_comments returns a flat array with no thread structure at all; Jira's
// comments arrive embedded and flat the same way; Figma's REST API returns
// a flat list that this codebase's own figma-comments.ts has to group into
// threads by parent_id by hand. GitLab's Discussions API instead already
// groups notes into Discussion objects server-side -- there is no manual
// threading step to write here at all, the opposite problem Figma had.
// parseDiscussionNotes only has to flatten each discussion's own notes array
// (skipping system notes) into one block of text, and buildItemDocument
// (this file's own local copy of mcp-framework/document.ts's
// buildProseDocument -- not imported, since this walker has no
// mcp-framework dependency, same choice figma-comments.ts's own
// buildThreadDocument and datadog-notebooks.ts's own buildNotebookDocument
// make) gives the result the exact same title-heading / body / "## Comments"
// shape Linear's and Jira's own issue documents get. chunkText's own
// heading-boundary rule still does the real chunking work; nothing about a
// GitLab discussion's shape needed a bespoke chunker to reach the same
// document shape every other MCP-in-style adapter in this sprint already
// produces.
//
// -- Scope control --
// Project allowlist, per the plan: options.projects is a required list of
// GitLab project ids or "namespace/project" paths, never resolved by
// listing a customer's groups or projects -- same "customer supplies the
// exact list" bias as every other adapter's board/team/project ids. Within
// an allowed project, listing its own merge requests and issues (capped at
// MAX_ITEMS_PER_PROJECT, ordered by most recently updated, one page, no
// pagination loop) is enumeration within an already-granted scope, not
// project discovery -- the same distinction mcp-linear.ts's own
// list_issues-within-a-team-or-project call draws. Each item's discussion
// thread read is capped at MAX_DISCUSSIONS_PER_ITEM for the same "seed a
// first rulebook, don't mirror the whole project's history" reasoning as
// figma-comments.ts's MAX_THREADS_PER_FILE.
//
// A project id/path that fails to list at all (bad token, project not
// found, no permission), or a single item's discussion fetch that fails,
// both propagate out of walkGitlabThreads and abort the rest of this
// walker's own run -- the same granularity figma-comments.ts's and
// datadog-notebooks.ts's own scope loops keep (no per-item try/catch
// either), not the narrower per-comments-call exception mcp-linear.ts and
// mcp-jira.ts carve out for their own "bonus, not the point" comment reads.
// That carve-out doesn't apply here: a discussion thread read is this
// connector's entire point, not a bonus layered on top of some other
// primary content, so there's no narrower call that's safe to swallow
// without silently losing the thing this connector exists to read.
// commands/prebrain.ts's own try/catch around this walker turns any of that
// into a single "GitLab threads walker skipped: <message>" line, and the
// rest of `gnt prebrain` still completes.
//
// -- Self-hosted GitLab --
// Supported, deliberately: GitLab is commonly self-managed, not just run on
// gitlab.com, and the plan's own task text calls this out as worth
// verifying rather than assuming. baseUrl defaults to DEFAULT_GITLAB_URL
// (https://gitlab.com) and is fully overridable (--gitlab-url, GNT_GITLAB_URL,
// or the value `gnt connect gitlab-threads` stored) -- every endpoint in
// GITLAB_ENDPOINTS is called against `<baseUrl>/api/v4`, the same versioned
// API path GitLab documents for both gitlab.com and a self-managed instance;
// nothing here is gitlab.com-specific.
//
// -- Honest limit on what's verified here --
// This codebase has no live GitLab project or access token to test against,
// so the exact response shape is confirmed against GitLab's own published
// REST API reference documentation, not a live call. Parsing is
// deliberately defensive for the same reason every other adapter's own
// parse functions are: a shape that doesn't match what's expected is
// dropped rather than guessed at, never thrown over.
import { chunkText, classifyDecisionProse } from "./chunk.js";
import type { PrebrainChunk } from "./types.js";

export const GITLAB_TOKEN_ID = "gitlab-threads";

export const DEFAULT_GITLAB_URL = "https://gitlab.com";

const REQUEST_TIMEOUT_MS = 15_000;

// Same "seed a first rulebook, don't mirror the whole project's history"
// reasoning as mcp-linear.ts's MAX_ISSUES_PER_SCOPE / mcp-jira.ts's
// MAX_ISSUES_PER_PROJECT -- one page, most-recently-updated first, no
// pagination loop.
const MAX_ITEMS_PER_PROJECT = 50;

// Same reasoning as figma-comments.ts's MAX_THREADS_PER_FILE -- GitLab's
// own documented per_page maximum, one page, no pagination loop.
const MAX_DISCUSSIONS_PER_ITEM = 100;

// See this file's own top-of-file "Content scope" section -- the exhaustive
// set of REST endpoints this connector ever calls, exported so a test can
// assert none of them (or their own descriptions) ever reference a diff,
// changes, or commits endpoint, not just that one happens to be unused.
export const GITLAB_ENDPOINTS: readonly { path: string; description: string }[] = [
  {
    path: "GET /projects/{id}/merge_requests",
    description:
      "List a project's merge requests (iid, title, description, web_url only) to enumerate which MRs to read discussion threads from.",
  },
  {
    path: "GET /projects/{id}/merge_requests/{merge_request_iid}/discussions",
    description: "Fetch one merge request's discussion threads and their notes -- never the diff or file changes.",
  },
  {
    path: "GET /projects/{id}/issues",
    description:
      "List a project's issues (iid, title, description, web_url only) to enumerate which issues to read discussion threads from.",
  },
  {
    path: "GET /projects/{id}/issues/{issue_iid}/discussions",
    description: "Fetch one issue's discussion threads and their notes.",
  },
  {
    path: "GET /user",
    description: "Fetch the token's own user identity; used only as the connect-flow validation probe, never during a walk.",
  },
];

export class MissingGitlabTokenError extends Error {
  constructor() {
    super(
      "No GitLab token found. Run `gnt connect gitlab-threads`, pass --gitlab-token, or set GNT_GITLAB_TOKEN.",
    );
    this.name = "MissingGitlabTokenError";
  }
}

export class GitlabApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitlabApiError";
  }
}

export interface GitlabCredentials {
  token: string;
  baseUrl: string;
}

// mcp-tokens.json stores one string per connector id (see ../credentials.ts).
// GitLab needs a token plus an optional instance base URL, so this
// connector's stored "token" is a small JSON envelope, same shape
// datadog-notebooks.ts already uses for its own multi-value credential.
export function serializeGitlabCredentials(creds: GitlabCredentials): string {
  return JSON.stringify(creds);
}

function parseStoredGitlabCredentials(raw: string | undefined): Partial<GitlabCredentials> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const obj = parsed as Record<string, unknown>;
    return {
      token: typeof obj.token === "string" ? obj.token : undefined,
      baseUrl: typeof obj.baseUrl === "string" ? obj.baseUrl : undefined,
    };
  } catch {
    return {};
  }
}

export interface ResolveGitlabCredentialsOptions {
  token?: string;
  baseUrl?: string;
  storedCredentials?: string;
}

// Same explicit-flag > env var > stored > default precedence every other
// connector in this CLI uses (see figma-comments.ts's resolveFigmaToken,
// datadog-notebooks.ts's resolveDatadogCredentials) -- applied per field,
// since GitLab needs two independent values rather than one token.
export function resolveGitlabCredentials(options: ResolveGitlabCredentialsOptions): GitlabCredentials {
  const stored = parseStoredGitlabCredentials(options.storedCredentials);
  const token = options.token ?? process.env.GNT_GITLAB_TOKEN ?? stored.token;
  const baseUrl = options.baseUrl ?? process.env.GNT_GITLAB_URL ?? stored.baseUrl ?? DEFAULT_GITLAB_URL;
  if (!token) throw new MissingGitlabTokenError();
  return { token, baseUrl };
}

function apiBase(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/v4`;
}

// GitLab's own convention for a project path with a slash in it ("group/
// subproject") -- URL-encoded in the :id path segment; a no-op for a plain
// numeric project id.
function encodeProjectId(project: string): string {
  return encodeURIComponent(project);
}

function authHeaders(creds: GitlabCredentials): Record<string, string> {
  return { "PRIVATE-TOKEN": creds.token };
}

function describeFetchError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Best-effort read of GitLab's own error payload shape (`{ message }`),
// falling back to a bare status code when the body isn't JSON or doesn't
// match. Never includes the token -- it only ever travels in the request's
// own PRIVATE-TOKEN header, never echoed into a message here.
async function describeErrorResponse(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const detail =
    body && typeof body === "object" && typeof (body as Record<string, unknown>).message === "string"
      ? (body as Record<string, unknown>).message
      : undefined;
  return detail ? `${res.status}: ${detail}` : `HTTP ${res.status}`;
}

async function fetchGitlabJson(
  path: string,
  creds: GitlabCredentials,
  fetchImpl: typeof fetch,
  context: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`${apiBase(creds.baseUrl)}${path}`, {
      headers: authHeaders(creds),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GitlabApiError(`Couldn't reach GitLab for ${context}: ${describeFetchError(err)}`);
  }
  if (!res.ok) {
    throw new GitlabApiError(`GitLab request failed for ${context} (${await describeErrorResponse(res)})`);
  }
  return res.json().catch(() => null);
}

// One real, side-effect-free read used to validate a pasted token before
// it's written to disk (see commands/connect-gitlab-threads.ts) -- GET
// /user needs no project scope and reads nothing about any project's
// content, the least-destructive live check this API offers.
export async function validateGitlabToken(creds: GitlabCredentials, fetchImpl: typeof fetch = fetch): Promise<void> {
  await fetchGitlabJson("/user", creds, fetchImpl, "token validation");
}

function fetchProjectMergeRequests(project: string, creds: GitlabCredentials, fetchImpl: typeof fetch): Promise<unknown> {
  return fetchGitlabJson(
    `/projects/${encodeProjectId(project)}/merge_requests?order_by=updated_at&sort=desc&per_page=${MAX_ITEMS_PER_PROJECT}`,
    creds,
    fetchImpl,
    `project ${project} merge requests`,
  );
}

function fetchProjectIssues(project: string, creds: GitlabCredentials, fetchImpl: typeof fetch): Promise<unknown> {
  return fetchGitlabJson(
    `/projects/${encodeProjectId(project)}/issues?order_by=updated_at&sort=desc&per_page=${MAX_ITEMS_PER_PROJECT}`,
    creds,
    fetchImpl,
    `project ${project} issues`,
  );
}

function fetchMrDiscussions(
  project: string,
  iid: number,
  creds: GitlabCredentials,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  return fetchGitlabJson(
    `/projects/${encodeProjectId(project)}/merge_requests/${iid}/discussions?per_page=${MAX_DISCUSSIONS_PER_ITEM}`,
    creds,
    fetchImpl,
    `merge request ${project}!${iid} discussions`,
  );
}

function fetchIssueDiscussions(
  project: string,
  iid: number,
  creds: GitlabCredentials,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  return fetchGitlabJson(
    `/projects/${encodeProjectId(project)}/issues/${iid}/discussions?per_page=${MAX_DISCUSSIONS_PER_ITEM}`,
    creds,
    fetchImpl,
    `issue ${project}#${iid} discussions`,
  );
}

interface GitlabListedItem {
  iid: number;
  title: string;
  description: string;
  webUrl?: string;
}

// Reads exactly iid/title/description/web_url off a raw MR or issue list
// entry -- see this file's own top-of-file "Content scope" section for the
// full list of fields deliberately never read (labels, assignee, milestone,
// state, and the rest). An entry missing an iid is dropped rather than
// guessed at, same "skip the bad row, not the whole read" bias every parser
// in this directory already has.
function parseListedItem(raw: unknown, defaultTitle: string): GitlabListedItem | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const iid = obj.iid;
  if (typeof iid !== "number") return null;

  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : defaultTitle;
  const description = typeof obj.description === "string" ? obj.description.trim() : "";
  const webUrl = typeof obj.web_url === "string" && obj.web_url ? obj.web_url : undefined;

  return { iid, title, description, webUrl };
}

function parseListedItems(data: unknown, defaultTitle: string): GitlabListedItem[] {
  const list = Array.isArray(data) ? data : [];
  const items: GitlabListedItem[] = [];
  for (const entry of list) {
    const parsed = parseListedItem(entry, defaultTitle);
    if (parsed) items.push(parsed);
  }
  return items;
}

// Flattens a discussions response into one block of comment text -- see
// this file's own top-of-file "Field discipline: notes" section for why
// `system` is read only as a skip gate and every other note field
// (author, timestamps, resolved state, position) is never read at all.
// GitLab already groups notes into threads server-side (see this file's own
// "Chunking" section), so this only has to flatten, never regroup.
function parseDiscussionNotes(data: unknown): string {
  const discussions = Array.isArray(data) ? data : [];
  const noteBodies: string[] = [];

  for (const discussion of discussions) {
    if (!discussion || typeof discussion !== "object") continue;
    const notes = (discussion as Record<string, unknown>).notes;
    if (!Array.isArray(notes)) continue;

    for (const note of notes) {
      if (!note || typeof note !== "object") continue;
      const noteObj = note as Record<string, unknown>;
      // A system-generated audit-trail entry ("changed the description",
      // "assigned to @user"), never something a person actually wrote --
      // dropped outright, not chunked.
      if (noteObj.system === true) continue;
      const body = noteObj.body;
      if (typeof body === "string" && body.trim()) noteBodies.push(body.trim());
    }
  }

  return noteBodies.join("\n\n");
}

// This file's own local copy of mcp-framework/document.ts's
// buildProseDocument -- not imported, since this walker has no
// mcp-framework dependency at all (see this file's own top-of-file "Why
// this isn't an MCP-in connector" section), same choice figma-comments.ts's
// buildThreadDocument and datadog-notebooks.ts's buildNotebookDocument
// already make. Identical shape on purpose: a title heading, the item's own
// description, then an optional "## Comments" heading -- so a GitLab thread
// chunks exactly the way a Linear or Jira issue does.
function buildItemDocument(title: string, description: string, comments: string): string {
  return [`# ${title}`, description, comments ? `## Comments\n\n${comments}` : ""].filter(Boolean).join("\n\n");
}

function fallbackSourcePath(project: string, kind: "merge_requests" | "issues", iid: number): string {
  return `gitlab/projects/${project}/${kind}/${iid}`;
}

function pushChunks(chunks: PrebrainChunk[], body: string, sourcePath: string): void {
  for (const chunk of chunkText(body)) {
    chunks.push({
      text: chunk.text,
      sourcePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      walker: "gitlab-threads",
      looksLikeDecisionProse: classifyDecisionProse(chunk.text),
    });
  }
}

export interface WalkGitlabThreadsOptions {
  token?: string;
  baseUrl?: string;
  storedCredentials?: string;
  /** Which GitLab projects (numeric id or "namespace/project" path) to read merge request and issue discussions from -- required; this walker never discovers projects or groups on its own, see this file's own "Scope control" section. */
  projects: string[];
  /** Injectable seam for tests -- defaults to the real global fetch. */
  fetchImpl?: typeof fetch;
}

// Public walker: same shape every other prebrain walker exposes. The
// empty-projects short-circuit stays here, ahead of resolving credentials,
// so an empty scope never makes a network call at all -- same behavior
// figma-comments.ts's/datadog-notebooks.ts's own empty-scope short-circuits
// keep.
//
// No per-item or per-project try/catch inside this loop -- see this file's
// own top-of-file "Scope control" section for why the narrower carve-out
// mcp-linear.ts/mcp-jira.ts apply to their own comments-only calls doesn't
// transfer here. Any failure propagates out of this function and aborts the
// rest of its own run; commands/prebrain.ts's own try/catch turns that into
// a single "GitLab threads walker skipped: <message>" line, and the rest of
// `gnt prebrain` still completes.
export async function walkGitlabThreads(options: WalkGitlabThreadsOptions): Promise<PrebrainChunk[]> {
  if (options.projects.length === 0) return [];

  const creds = resolveGitlabCredentials({
    token: options.token,
    baseUrl: options.baseUrl,
    storedCredentials: options.storedCredentials,
  });
  const fetchImpl = options.fetchImpl ?? fetch;

  const chunks: PrebrainChunk[] = [];
  for (const project of options.projects) {
    const mrs = parseListedItems(
      await fetchProjectMergeRequests(project, creds, fetchImpl),
      "Untitled merge request",
    ).slice(0, MAX_ITEMS_PER_PROJECT);
    for (const mr of mrs) {
      const commentsText = parseDiscussionNotes(await fetchMrDiscussions(project, mr.iid, creds, fetchImpl));
      const body = buildItemDocument(mr.title, mr.description, commentsText);
      if (body.trim()) pushChunks(chunks, body, mr.webUrl ?? fallbackSourcePath(project, "merge_requests", mr.iid));
    }

    const issues = parseListedItems(await fetchProjectIssues(project, creds, fetchImpl), "Untitled issue").slice(
      0,
      MAX_ITEMS_PER_PROJECT,
    );
    for (const issue of issues) {
      const commentsText = parseDiscussionNotes(await fetchIssueDiscussions(project, issue.iid, creds, fetchImpl));
      const body = buildItemDocument(issue.title, issue.description, commentsText);
      if (body.trim()) pushChunks(chunks, body, issue.webUrl ?? fallbackSourcePath(project, "issues", issue.iid));
    }
  }

  return chunks;
}

// Shared types for prebrain: the walkers here turn
// a customer's own local sources into candidate decision-prose chunks.
// This file is the contract 2.2 (company profile), 2.3 (extraction, which
// runs every chunk through applyPrivacyGate before a model sees it -- see
// ../privacy-gate/index.ts), and 2.4 (batched PR output) build on, so keep
// it stable: add fields, don't reshape existing ones without checking who
// reads them downstream.

// Which walker produced a chunk. Extend this union, not a bare string, the
// same reasoning as privacy-gate/types.ts's PlaceholderKind -- a typo in a
// walker file becomes a compile error, not a silent mismatch with whatever
// filters 2.2+ add per source.
//
// "mcp-notion" / "mcp-monday": the live counterparts to
// notion-export -- same target content, read through the customer's own
// Notion/monday.com MCP server instead of a static export. See
// ../prebrain/mcp-notion.ts and mcp-monday.ts's own doc comments for the
// read-only guarantee and auth model; both are opt-in walkers, unlike
// every walker above, which is why commands/prebrain.ts gates them behind
// their own flags instead of running them whenever a path is passed.
//
// "mcp-sentry": same opt-in MCP-in shape, read
// through the customer's own Sentry MCP server. Narrower than the other
// two -- see mcp-sentry.ts's own doc comment for why only an issue's
// title/status/permalink is read (search_issues), and why comments and
// full issue details are not reachable through this adapter at all.
//
// "gmail-export": the interim Gmail path -- reads
// a Google Takeout mail export (.mbox) instead of a live OAuth connection,
// which needs no vendor approval (the real Gmail OAuth connector is
// blocked on Google's own app-review process, tracked separately). See
// gmail-export.ts, mbox.ts, and mail-chunk.ts's own doc comments for the
// mbox/MIME parsing, thread reconstruction, and quote-stripping this
// walker does before producing chunks. Gated behind --gmail like
// notion-export is behind --notion, not opt-in-boolean like the MCP-in
// walkers above -- it's a local file path, not a live connection.
//
// "outlook-export": the same interim-local-path
// story for Outlook -- reads a directory of .eml files or a single
// mbox-shaped file instead of a live Graph API connection. Reuses
// mbox.ts's parseMailMessage/splitMboxMessages and mail-chunk.ts's
// chunkMailThreads unchanged; see outlook-export.ts's own doc comment for
// what Outlook's export flow actually supports and why PST parsing is out
// of scope. Gated behind --outlook, same "local file path" reasoning as
// --gmail.
//
// "mcp-linear": the third MCP-in adapter, same
// framework as mcp-notion/mcp-monday -- issue descriptions and comments,
// plus project documents, read through a customer's own Linear API key.
// See ../prebrain/mcp-linear.ts's own doc comment for the read-only
// guarantee, the team/project allowlist, and why it connects through a
// local stdio bridge rather than a spawned local server the way Notion and
// monday's adapters do.
//
// "mcp-jira": built after mcp-linear.ts to reuse
// its "no dedicated comment-thread chunker" call -- issue summaries,
// descriptions, and comments, read through a customer's own Atlassian API
// token, scoped to the projects and Atlassian site (cloud id) given. See
// ../prebrain/mcp-jira.ts's own doc comment for the read-only guarantee,
// why a cloud id is required alongside project keys (Linear's own token
// model has no multi-site equivalent), and adf-to-text.ts for the
// Atlassian Document Format handling Jira's rich-text fields need that
// Linear's plain-string fields don't.
//
// "mcp-granola": reads meeting notes and verbatim
// transcripts from a customer's own Granola folders through Granola's
// official MCP server -- see ../prebrain/mcp-granola.ts's own doc comment
// for the read-only guarantee, the folder-scoped allowlist, and the
// honest limit on Granola's OAuth-only auth model. Chunked with
// ../prebrain/transcript-chunk.ts's speaker-turn/decision-moment chunker,
// which the Zoom adapter and the meeting-export walkers are built to
// reuse rather than duplicate. Opt-in like the other MCP-in walkers, never
// run without --mcp-granola.
//
// "figma-comments": reads comment threads on
// customer-chosen Figma files direct against Figma's own REST API -- not
// an MCP-in walker like mcp-notion/mcp-monday/mcp-linear above, no MCP
// transport or mcp-framework machinery is involved at all. See
// ../prebrain/figma-comments.ts's own doc comment for the endpoint, auth,
// and hand-kept field discipline. Opt-in like the MCP-in walkers, gated
// behind --figma-comments plus a required --figma-files scope.
//
// "mcp-zoom": reads recording transcripts from
// customer-chosen Zoom hosts, scoped to a date range, through Zoom's own
// official MCP server -- see ../prebrain/mcp-zoom.ts's own doc comment for
// the read-only guarantee, the host+date-range allowlist, and the auth
// model (a hosted remote server, a user OAuth access token pasted as a
// static bearer credential through mcp-remote, same bridging shape as
// mcp-linear). get_recording_resource's caption-timeline JSON is converted
// to transcript-chunk.ts's own "Name: text" turn shape before chunking, but
// the shared chunker itself (../prebrain/transcript-chunk.ts, built for
// mcp-granola.ts) is reused unchanged. Opt-in like the other MCP-in
// walkers, never run without --mcp-zoom.
//
// "datadog-notebooks": reads customer-named
// Datadog notebooks -- title plus markdown cell text only -- direct
// against Datadog's own REST API, the same "no mcp-framework machinery at
// all" shape as figma-comments above (Datadog does have an official MCP
// server, but only over a remote-HTTP/OAuth transport this framework's
// stdio-only mcp-connector.ts can't reach -- see
// ../prebrain/datadog-notebooks.ts's own doc comment). Notebooks are also
// where Datadog's own incident postmortems live, so this one read path
// covers both; metrics, monitor definitions, log data, and the separate
// Incidents API are never read. Opt-in, gated behind --datadog-notebooks
// plus a required --datadog-notebook-ids scope.
//
// "hubspot-notes": reads HubSpot Note engagements
// -- a note's own written text only -- scoped to deals within an
// allowlisted pipeline ("deal notes") and/or notes owned by an allowlisted
// team's members ("engagement notes"), direct against HubSpot's own REST
// CRM API, the same "no mcp-framework machinery at all" shape as
// figma-comments/datadog-notebooks above. See
// ../prebrain/hubspot-notes.ts's own doc comment for why (both of
// HubSpot's official MCP surfaces were checked and ruled out: one is
// OAuth-only remote, the other's tool granularity can't be verified
// without a live account, and this is the sprint's own declared
// highest-leak-risk connector). Contact records, company records, and a
// deal's own fields (amount, stage, close date) are never read -- only a
// note's own body text, with an embedded contact/company/deal object
// stripped before this connector's own code ever reads a field off it.
// Playbook content (also named in the original scope) has no public
// HubSpot API today, so it's out of scope here, called out rather than
// silently dropped. Opt-in, gated behind --hubspot-notes plus at least one
// of --hubspot-pipelines / --hubspot-teams.
//
// "meeting-notes-export": reads local meeting-
// transcript exports from Otter.ai, Fireflies.ai, and Fathom -- a
// directory or a single file, VTT/SRT cue files and plain-text transcripts
// both auto-detected per file rather than needing a per-tool flag. See
// ../prebrain/meeting-notes-export.ts's own doc comment for what each
// vendor's export flow actually supports today (none of the three
// natively produces WebVTT; two of the three produce SRT, which shares
// the same cue-block shape a VTT parser needs anyway) and for the cue-
// merge step that makes time-sliced caption cues safe to hand to
// ../prebrain/transcript-chunk.ts's speaker-turn/decision-moment chunker
// unchanged. Gated behind --meeting-notes, same "local file path" shape as
// --gmail/--outlook, not opt-in-boolean like the MCP-in walkers above.
//
// "gitlab-threads": reads merge request discussion
// threads and issue discussion threads on customer-chosen GitLab projects
// direct against GitLab's own REST API -- not an MCP-in walker like
// mcp-linear/mcp-jira above, no MCP transport or mcp-framework machinery is
// involved at all, same "no framework here" shape as figma-comments and
// datadog-notebooks. See ../prebrain/gitlab-threads.ts's own doc comment
// for the endpoint, auth (a customer-supplied project/personal access
// token, read_api scope), self-hosted-instance support, and hand-kept field
// discipline -- a note's author, timestamps, and resolved state are never
// read, and a system-generated audit-trail note is dropped outright.
// Opt-in like the other direct-REST walkers, gated behind --gitlab-threads
// plus a required --gitlab-projects scope.
//
// "airtable": reads customer-picked prose fields
// out of a customer's own Airtable base, direct against Airtable's
// Metadata and Records REST API -- not an MCP-in walker, no mcp-framework
// machinery involved (see ../prebrain/airtable.ts's own doc comment). The
// one connector in this sprint where the safe-field allowlist can't be
// declared at build time at all: a base's fields are entirely
// customer-defined, so `gnt connect airtable` walks the customer through
// picking exactly which fields, per table, are safe prose, live against
// that base's real schema, and persists that selection alongside the
// token. This walker refuses to read anything outside the saved selection
// -- see airtable.ts's own "Field discipline" section for how that's
// enforced structurally, not by convention. Opt-in like every other REST
// connector here, gated behind --airtable, but with no scope flags at
// all: unlike --figma-files/--datadog-notebook-ids, the base/tables/fields
// scope is fixed entirely at connect time, not re-specifiable per run --
// see airtable.ts's own walkAirtable doc comment for why.
export type PrebrainWalker =
  | "repo-scan"
  | "docs-dir"
  | "notion-export"
  | "mcp-notion"
  | "mcp-monday"
  | "mcp-linear"
  | "mcp-jira"
  | "mcp-sentry"
  | "mcp-granola"
  | "mcp-zoom"
  | "gmail-export"
  | "outlook-export"
  | "figma-comments"
  | "datadog-notebooks"
  | "gitlab-threads"
  | "hubspot-notes"
  | "meeting-notes-export"
  | "airtable";

// A loose, cheap signal -- not a classification. Real extraction judgment
// is 2.3's job (it has a model to call); this only exists so `gnt prebrain`
// can print something more useful than a raw chunk count, e.g. surfacing
// the more promising chunks first. Never treat "low" as "discard" -- 2.3
// still gets every chunk regardless of this field.
export type DecisionProseSignal = "high" | "medium" | "low";

// A candidate decision-prose chunk: a paragraph/section-sized piece of a
// source file (never a whole-file dump), with enough provenance to trace
// it back to the exact lines it came from and to build a source citation
// once a rule is drafted from it.
export interface PrebrainChunk {
  /** The chunk's raw text, already trimmed. Plain text in -- nothing here has been through the privacy gate yet. */
  text: string;
  /**
   * Path to the source file this chunk came from.
   *   - repo-scan: relative to the scanned repo root.
   *   - docs-dir: relative to the scanned docs directory.
   *   - notion-export: relative to the extracted zip's root, i.e. it
   *     roughly mirrors the page tree Notion exported (nested folders per
   *     page), not the original .zip path.
   *   - mcp-notion: the live page's own Notion URL, or `page/<page-id>`
   *     if the server's response didn't include one.
   *   - mcp-monday: `boards/<board-id>/items/<item-id>`, mirroring how an
   *     item is addressed in monday.com's own data model -- there is no
   *     file path for an API object, so this is the closest honest
   *     equivalent, same reasoning docs-dir/notion-export apply to a real
   *     file path.
   *   - mcp-linear: the issue or document's own Linear URL, or
   *     `issues/<issue-id>` / `documents/<document-id>` if the server's
   *     response didn't include one -- same "URL when the vendor gives one,
   *     otherwise a stable id path" rule as mcp-notion above.
   *   - mcp-jira: the issue's own Jira browse URL
   *     (`<site>/browse/<KEY>`), built from the site URL when
   *     --jira-cloud-id was given one, or a vendor-returned url/browseUrl
   *     field, or `jira/<cloud-id>/<key>` if neither is available -- see
   *     mcp-jira.ts's own issueSourcePath for why a Jira REST API "self"
   *     link is never used here.
   *   - mcp-granola: the meeting note's own Granola deep link where the
   *     API returns one, or `meetings/<meeting-id>` otherwise -- same
   *     "vendor URL if we have it, stable id path if we don't" fallback as
   *     mcp-notion's page URL.
   *   - mcp-zoom: the recording's own share_url or play_url where the API
   *     returns one, or `recordings/<meeting-uuid>` otherwise -- same
   *     "vendor URL if we have it, stable id path if we don't" fallback as
   *     mcp-granola's meeting path.
   *   - gmail-export / outlook-export: `threads/<subject-slug>-<hash>`,
   *     one path per reconstructed thread -- a thread isn't a single file
   *     either, so this follows the same "closest honest equivalent"
   *     reasoning as mcp-monday's item address above. See mail-chunk.ts's
   *     own comment for how the slug and hash are derived. Both walkers
   *     share this exact convention since both hand their parsed messages
   *     to the same chunkMailThreads function.
   *   - figma-comments: `figma/files/<file-key>/comments/<root-comment-id>`,
   *     one path per comment thread -- no file name or deep-link URL is
   *     attached (the comments endpoint doesn't return one and this
   *     walker never calls a files endpoint to fetch one), so this is the
   *     same "stable id path over a call this walker doesn't otherwise
   *     need" choice mcp-monday's item address makes.
   *   - datadog-notebooks: the notebook's own Datadog app URL,
   *     `https://app.<site>/notebook/<id>` -- a real deep link, unlike
   *     figma-comments above, since the notebook id and site are already
   *     known without an extra call.
   *   - hubspot-notes: `hubspot/deals/<deal-id>/notes/<note-id>` for a
   *     deal-scoped note, or `hubspot/notes/<note-id>` for a team-scoped
   *     one -- HubSpot has no public per-note deep link, so this is a
   *     stable id path, same "closest honest equivalent" reasoning as
   *     figma-comments' own comment-thread path above. A deal id here is
   *     an internal database key used only for addressing, never a deal
   *     record field.
   *   - meeting-notes-export: the source file's path relative to the
   *     directory --meeting-notes pointed at, or just the file's own name
   *     if --meeting-notes pointed at a single file -- one path per export
   *     file (one meeting), the same file-relative convention docs-dir
   *     uses, not the reconstructed-thread convention gmail-export/
   *     outlook-export use, since there's no cross-file thread to
   *     reconstruct here.
   *   - airtable: the record's own Airtable deep link,
   *     `https://airtable.com/<base-id>/<table-id>/<record-id>` -- a real
   *     vendor URL, not a stable-id fallback, since every piece it needs is
   *     already in hand from the saved config and the record read, same
   *     "real deep link when nothing extra is needed for one" choice
   *     datadog-notebooks.ts's notebook URL makes.
   */
  sourcePath: string;
  /**
   * 1-indexed, inclusive line span within sourcePath that this chunk
   * covers. For the two MCP-in walkers, sourcePath isn't a real file --
   * these are offsets into the synthesized text blob (page markdown, or
   * item fields + comments joined) chunkText actually chunked, the same
   * "line span into whatever text was walked" contract every other
   * walker keeps, not a line number in anything Notion/monday.com/Linear
   * themselves would show a human. gmail-export and outlook-export follow
   * the same contract: an offset into the synthesized per-thread
   * transcript mail-chunk.ts built, not a line number in any source
   * .mbox/.eml file. mcp-granola follows it too: an offset into the
   * synthesized transcript-plus-notes body transcript-chunk.ts actually
   * chunked, not a timestamp in Granola's own transcript. meeting-notes-
   * export follows the same contract: an offset into the synthesized
   * "# <title>" plus normalized-turns document this walker builds per
   * file (VTT/SRT cues merged into turns, or plain-text bracket/paren
   * timestamps stripped), not a cue index or byte offset in the original
   * export file. airtable follows the same contract too: an offset into
   * the synthesized "# <table> record" plus per-field sections document
   * this walker builds per record, not a row or column position in the
   * base itself.
   */
  startLine: number;
  /** 1-indexed, inclusive -- same line as startLine for a single-line chunk. */
  endLine: number;
  /** Which walker produced this chunk. */
  walker: PrebrainWalker;
  /** See DecisionProseSignal's own doc comment -- a hint, not a filter. */
  looksLikeDecisionProse: DecisionProseSignal;
}

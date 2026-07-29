// prebrain: local walkers that turn a customer's
// own sources into candidate decision-prose chunks -- the front half of
// the cold-start fix, ahead of extraction (2.3) and PR output (2.4).
//
// Every walker here is local-only: no network calls, nothing routes
// through gnt infrastructure. See ../privacy-gate/index.ts for the gate
// this output runs through before any model (local or cloud) sees it --
// that wiring is 2.3's job, not this one's.
export { classifyRepoScanTarget, walkRepoScan } from "./repo-scan.js";
export type { RepoScanCategory } from "./repo-scan.js";
export { walkDocsDir } from "./docs-dir.js";
export { walkNotionExport } from "./notion-export.js";
export { classifyDecisionProse, chunkText } from "./chunk.js";
export type { TextChunk } from "./chunk.js";
// Shared transcript chunker -- speaker-turn and
// decision-moment-aware, built for mcp-granola.ts and reused by the Zoom
// adapter and the meeting-export walkers. See its own doc comment.
export { chunkTranscript, parseSpeakerTurns } from "./transcript-chunk.js";
export type { SpeakerTurn } from "./transcript-chunk.js";
export { extractZip } from "./zip.js";
export type { DecisionProseSignal, PrebrainChunk, PrebrainWalker } from "./types.js";

// Gmail export walker -- see gmail-export.ts's own
// doc comment for the interim-Gmail-path framing, mbox.ts for mbox/MIME
// parsing, and mail-chunk.ts for thread reconstruction/quote-stripping,
// which the Outlook export walker below reuses directly.
export { walkGmailExport } from "./gmail-export.js";
export type { WalkGmailExportOptions } from "./gmail-export.js";
export { parseMailMessage, splitMboxMessages } from "./mbox.js";
export type { ParsedMailMessage } from "./mbox.js";
export { buildThreads, chunkMailThreads, stripQuotedContent, threadToChunks } from "./mail-chunk.js";
export type { MailThread } from "./mail-chunk.js";
export { htmlToText } from "./html-to-text.js";

// Outlook export walker -- see outlook-export.ts's
// own doc comment for what Outlook's export flow actually supports, the
// .eml/mbox scope, and why PST parsing is out of scope.
export { walkOutlookExport } from "./outlook-export.js";
export type { WalkOutlookExportOptions } from "./outlook-export.js";

// Meeting-notes export walker -- reads Otter/
// Fireflies/Fathom transcript exports (VTT/SRT cue files and plain-text
// transcripts, auto-detected) and feeds them through the same shared
// transcript chunker mcp-granola.ts uses. See meeting-notes-export.ts's
// own doc comment for what each vendor's export flow actually supports.
export {
  parseCueTranscript,
  parsePlainTextTranscript,
  walkMeetingNotesExport,
} from "./meeting-notes-export.js";

// MCP-in walkers -- opt-in, live-network walkers, unlike
// everything above. See mcp-connector.ts's own doc comment for the shared
// read-only/local-trust-boundary contract both of these keep.
export { MissingNotionMcpTokenError, resolveNotionMcpToken, walkMcpNotion } from "./mcp-notion.js";
export type { WalkMcpNotionOptions } from "./mcp-notion.js";
export { MissingMondayMcpTokenError, resolveMondayMcpToken, walkMcpMonday } from "./mcp-monday.js";
export type { WalkMcpMondayOptions } from "./mcp-monday.js";
export { MissingLinearMcpTokenError, resolveLinearMcpToken, walkMcpLinear } from "./mcp-linear.js";
export type { WalkMcpLinearOptions } from "./mcp-linear.js";
export { MissingJiraMcpTokenError, resolveJiraMcpToken, walkMcpJira } from "./mcp-jira.js";
export type { WalkMcpJiraOptions } from "./mcp-jira.js";
export { MissingSentryMcpTokenError, resolveSentryMcpToken, walkMcpSentry } from "./mcp-sentry.js";
export type { WalkMcpSentryOptions } from "./mcp-sentry.js";
export { MissingGranolaMcpTokenError, resolveGranolaMcpToken, walkMcpGranola } from "./mcp-granola.js";
export type { WalkMcpGranolaOptions } from "./mcp-granola.js";
export { MissingZoomMcpTokenError, resolveZoomMcpToken, walkMcpZoom } from "./mcp-zoom.js";
export type { WalkMcpZoomOptions } from "./mcp-zoom.js";
export { McpConnectorError } from "./mcp-connector.js";
export type { McpToolClient } from "./mcp-connector.js";

// Figma comments walker -- direct against
// Figma's own REST API, not an MCP-in walker, so it has no mcp-framework
// dependency at all. See figma-comments.ts's own doc comment for the
// endpoint, auth, and field-discipline details.
export {
  FIGMA_TOKEN_ID,
  FigmaApiError,
  MissingFigmaTokenError,
  resolveFigmaToken,
  validateFigmaToken,
  walkFigmaComments,
} from "./figma-comments.js";
export type { WalkFigmaCommentsOptions } from "./figma-comments.js";

// Datadog notebooks client -- direct against
// Datadog's own REST API, not an MCP-in walker, same "no mcp-framework
// dependency at all" shape as figma-comments.ts above. See
// datadog-notebooks.ts's own doc comment for the endpoint, auth, field
// discipline, and why an official Datadog MCP server exists but this
// framework's stdio-only transport can't reach it.
export {
  DATADOG_ENDPOINTS,
  DATADOG_TOKEN_ID,
  DatadogApiError,
  DEFAULT_DATADOG_SITE,
  MissingDatadogCredentialsError,
  resolveDatadogCredentials,
  serializeDatadogCredentials,
  validateDatadogCredentials,
  walkDatadogNotebooks,
} from "./datadog-notebooks.js";
export type { DatadogCredentials, WalkDatadogNotebooksOptions } from "./datadog-notebooks.js";

// GitLab threads client -- direct against GitLab's
// own REST API, not an MCP-in walker, same "no mcp-framework dependency at
// all" shape as figma-comments.ts/datadog-notebooks.ts above. See
// gitlab-threads.ts's own doc comment for the endpoint, auth (a customer
// project/personal access token), self-hosted-instance support, and why
// GitLab's own official MCP server (OAuth Dynamic Client Registration,
// still Beta) doesn't fit this framework's static-token connect model.
export {
  DEFAULT_GITLAB_URL,
  GITLAB_ENDPOINTS,
  GITLAB_TOKEN_ID,
  GitlabApiError,
  MissingGitlabTokenError,
  resolveGitlabCredentials,
  serializeGitlabCredentials,
  validateGitlabToken,
  walkGitlabThreads,
} from "./gitlab-threads.js";
export type { GitlabCredentials, WalkGitlabThreadsOptions } from "./gitlab-threads.js";

// HubSpot notes client -- direct against
// HubSpot's own REST CRM API, not an MCP-in walker, same "no mcp-framework
// dependency at all" shape as figma-comments.ts/datadog-notebooks.ts
// above. See hubspot-notes.ts's own doc comment for the endpoint, auth,
// scope model, and the field discipline that keeps contact/company/deal
// record data out of every chunk -- the sprint's own declared
// highest-leak-risk connector.
export {
  HUBSPOT_API_BASE,
  HUBSPOT_ENDPOINTS,
  HUBSPOT_TOKEN_ID,
  HubspotApiError,
  MissingHubspotTokenError,
  resolveHubspotToken,
  validateHubspotToken,
  walkHubspotNotes,
} from "./hubspot-notes.js";
export type { WalkHubspotNotesOptions } from "./hubspot-notes.js";

// Airtable connector -- direct against Airtable's
// Metadata and Records REST API, not an MCP-in walker, same "no
// mcp-framework dependency at all" shape as figma-comments.ts and
// datadog-notebooks.ts above. See airtable.ts's own doc comment for the
// endpoint shapes and, most importantly, why the field allowlist here is
// customer-chosen at connect time rather than declared in this file the
// way every other connector's is.
export {
  AIRTABLE_API_BASE,
  AIRTABLE_ENDPOINTS,
  AIRTABLE_TOKEN_ID,
  AirtableApiError,
  getBaseSchema,
  hasStoredAirtableConnection,
  listAccessibleBases,
  MissingAirtableConfigError,
  MissingAirtableTokenError,
  PROSE_SHAPED_FIELD_TYPES,
  resolveAirtableToken,
  serializeAirtableConfig,
  walkAirtable,
} from "./airtable.js";
export type {
  AirtableBaseSummary,
  AirtableConnectorConfig,
  AirtableFieldSchema,
  AirtableTableSchema,
  AirtableTableSelection,
  WalkAirtableOptions,
} from "./airtable.js";

// gnt prebrain: the front half of the cold-start fix --
// a brand-new org has an empty rulebook and no fast way to fill it. This
// command walks whichever local sources the caller points it at, runs a
// short company-profile pass, extracts candidate rules from what it found
// (every chunk through the privacy gate first, always), and opens them as
// batched, human-reviewable draft PRs against the org's connected rules
// repo. Source text itself never leaves this process except to whichever
// model extraction calls (the customer's own cloud key or their own local
// Ollama daemon, per --mode) -- this command's own network calls are only
// ever to gnt's API, and only ever rule text/provenance that already went
// through the gate.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { API_URL } from "../config.js";
import { loadApiKey, loadMcpToken } from "../credentials.js";
import { bootstrapDashboardToken } from "../prebrain/mcp-framework/index.js";
import { linearAdapter } from "../prebrain/mcp-linear.js";
import { notionAdapter } from "../prebrain/mcp-notion.js";
import {
  AIRTABLE_TOKEN_ID,
  classifyRepoScanTarget,
  DATADOG_TOKEN_ID,
  FIGMA_TOKEN_ID,
  GITLAB_TOKEN_ID,
  HUBSPOT_TOKEN_ID,
  walkAirtable,
  walkDatadogNotebooks,
  walkDocsDir,
  walkFigmaComments,
  walkGitlabThreads,
  walkGmailExport,
  walkHubspotNotes,
  walkMcpGranola,
  walkMcpJira,
  walkMcpLinear,
  walkMcpMonday,
  walkMcpNotion,
  walkMcpSentry,
  walkMcpZoom,
  walkMeetingNotesExport,
  walkNotionExport,
  walkOutlookExport,
  walkRepoScan,
} from "../prebrain/index.js";
import type {
  PrebrainChunk,
  PrebrainWalker,
  WalkAirtableOptions,
  WalkDatadogNotebooksOptions,
  WalkFigmaCommentsOptions,
  WalkGitlabThreadsOptions,
  WalkGmailExportOptions,
  WalkHubspotNotesOptions,
  WalkMcpGranolaOptions,
  WalkMcpJiraOptions,
  WalkMcpLinearOptions,
  WalkMcpMondayOptions,
  WalkMcpNotionOptions,
  WalkMcpSentryOptions,
  WalkMcpZoomOptions,
  WalkOutlookExportOptions,
} from "../prebrain/index.js";
import { ExtractionError, extractRules } from "../prebrain/extraction/index.js";
import type { ExtractedRule, ExtractionMode, ExtractionOptions } from "../prebrain/extraction/index.js";
import { runCompanyProfile } from "../prebrain/profile.js";
import type { CompanyProfile } from "../prebrain/profile.js";
import { runSourcePicker } from "../prebrain/source-picker.js";
import type { SourcePickerFields } from "../prebrain/source-picker.js";
import { listStarterPackIds, resolveStarterPacks } from "../prebrain/starter-packs/index.js";
import type { StarterPackSelection } from "../prebrain/starter-packs/index.js";
import { applyPrivacyGate } from "../privacy-gate/index.js";
import { bold, dim, fail, muted, success, text } from "../theme.js";

export interface PrebrainOptions {
  docs?: string;
  notion?: string;
  // Gmail export walker: --gmail points at a
  // single Google Takeout mail export (.mbox), same "one flag, one path"
  // shape as --notion's export .zip. The scope-control flags below exist
  // because a Takeout export can be a whole mailbox's lifetime history --
  // see gmail-export.ts's own doc comment; all three are optional, since
  // a label-filtered Takeout export (documented on the docs site) scopes
  // things down before the file ever reaches this CLI.
  gmail?: string;
  gmailSince?: string;
  gmailUntil?: string;
  // Comma-separated bare addresses or bare domains, same convention as
  // --monday-boards below.
  gmailFrom?: string;
  // Outlook export walker: --outlook points at
  // either a directory of .eml files or a single mbox-shaped file -- see
  // outlook-export.ts's own doc comment for why both are supported and
  // what Outlook's export flow actually produces. Same scope-control
  // flags and same "malformed date is a hard error" behavior as --gmail's
  // own flags above.
  outlook?: string;
  outlookSince?: string;
  outlookUntil?: string;
  outlookFrom?: string;
  // Meeting-notes export walker: --meeting-notes
  // points at a directory or a single file of Otter/Fireflies/Fathom
  // transcript exports -- VTT/SRT cue files and plain-text transcripts,
  // auto-detected per file (see meeting-notes-export.ts's own doc comment
  // for why one flag covers all three vendors rather than one flag each).
  // No scope-control flags like --gmail/--outlook have: a meeting-notes
  // export is one file per meeting, not a mailbox's entire history, so
  // there's nothing here that needs bounding by date or sender.
  meetingNotes?: string;
  mode?: ExtractionMode;
  apiKey?: string;
  aiGatewayApiKey?: string;
  anthropicModel?: string;
  ollamaHost?: string;
  ollamaModel?: string;
  // "all", or a comma-separated list of pack ids (see
  // prebrain/starter-packs/index.ts) -- opt-in only, never inferred from
  // how thin real extraction's own output looks. Undefined means no
  // starter-pack rules at all, same as not passing --docs/--notion.
  starterPacks?: string;
  // --all: turns on every connector's own opt-in boolean below (mcpNotion,
  // mcpMonday, ..., airtable) in one flag, instead of a customer having to
  // list all twelve by name every run. Purely a shorthand for those
  // booleans -- it does NOT invent scope. A connector that needs a
  // per-run scope flag (--gitlab-projects, --hubspot-pipelines/--hubspot-
  // teams, --datadog-notebook-ids, --figma-files, --linear-teams/--linear-
  // projects, --jira-projects, --sentry-projects, --monday-boards,
  // --zoom-hosts) still skips with its own existing "needs at least one X"
  // message if that flag isn't also passed -- --all only ever widens which
  // connectors are attempted, never which of their own content a
  // connector is allowed to read. See resolveInputs's own handling below.
  all?: boolean;
  // MCP-in walkers: both opt-in booleans, never run
  // just because a token happens to be configured -- see collectChunks's
  // own comment for why. Token options fall back to a locally stored
  // `gnt connect notion-mcp`/`monday-mcp` credential, then an env var,
  // same precedence extraction's own --api-key/ANTHROPIC_API_KEY already
  // uses (see extraction/cloud.ts's resolveCloudApiKey).
  mcpNotion?: boolean;
  notionMcpToken?: string;
  mcpMonday?: boolean;
  mondayMcpToken?: string;
  // Comma-separated monday.com board ids -- required alongside --mcp-monday,
  // see mcp-monday.ts's own doc comment for why this walker never
  // discovers boards on its own.
  mondayBoards?: string;
  // Linear MCP-in walker -- same opt-in-boolean
  // shape as mcpNotion/mcpMonday above, see mcp-linear.ts's own doc
  // comment for the read-only guarantee and auth model.
  mcpLinear?: boolean;
  linearMcpToken?: string;
  // Comma-separated Linear team/project ids -- at least one of the two is
  // required alongside --mcp-linear, same "no auto-discovery" reasoning as
  // --monday-boards above.
  linearTeams?: string;
  linearProjects?: string;
  // Jira MCP-in walker -- same opt-in-boolean shape
  // as mcpLinear above, see mcp-jira.ts's own doc comment for the
  // read-only guarantee and auth model. Unlike Linear, this one also needs
  // --jira-cloud-id: Atlassian's MCP server is multi-site, so every call
  // has to know which site to route to, not just which project to scope to.
  mcpJira?: boolean;
  jiraMcpToken?: string;
  // Atlassian site URL (https://yourteam.atlassian.net) or raw cloud id --
  // required alongside --mcp-jira, see mcp-jira.ts's own "Scope" section.
  jiraCloudId?: string;
  // Comma-separated Jira project keys -- required alongside --mcp-jira,
  // same "no auto-discovery" reasoning as --monday-boards above.
  jiraProjects?: string;
  mcpSentry?: boolean;
  sentryMcpToken?: string;
  // Required alongside --mcp-sentry -- same "never auto-discover" reasoning
  // as --monday-boards above, see mcp-sentry.ts's own doc comment.
  sentryOrg?: string;
  sentryProjects?: string;
  // Granola -- same opt-in-boolean-plus-scope-ids
  // shape as --mcp-monday/--monday-boards above; see mcp-granola.ts's own
  // doc comment for why this walker never discovers folders on its own.
  // Deliberately no --granola-mcp-token-equivalent field here: Granola's
  // MCP server has no token-based auth to override with a flag (browser
  // sign-in only, via `gnt connect granola-mcp`) -- see mcp-granola.ts's
  // own "Honest limit" section.
  mcpGranola?: boolean;
  granolaFolders?: string;
  // Zoom MCP-in walker -- same opt-in-boolean-plus-
  // scope shape as --mcp-sentry/--sentry-org above; see mcp-zoom.ts's own
  // doc comment for the read-only guarantee, the host+date-range allowlist,
  // and the auth model (a hosted remote MCP server, a user OAuth access
  // token pasted as a static bearer credential through mcp-remote, same
  // bridging shape as --mcp-linear).
  mcpZoom?: boolean;
  zoomMcpToken?: string;
  // Comma-separated Zoom host user ids or emails -- required alongside
  // --mcp-zoom, same "never auto-discover" reasoning as --monday-boards
  // above.
  zoomHosts?: string;
  // Optional recordings_list date-range narrowing, Zoom's own "yyyy-mm-dd"
  // format. Both optional: recordings_list itself defaults to just the
  // current day when neither is passed, so an unscoped call here is never a
  // full-history pull the way an unscoped --gmail/--outlook would be --
  // unlike gmailSince/gmailUntil, a malformed value here isn't parsed as a
  // Date at all, it's passed straight through to the vendor's own
  // "yyyy-mm-dd" parameter.
  zoomFrom?: string;
  zoomTo?: string;
  // Figma comments walker: opt-in boolean, same
  // "never run just because a token happens to be configured" reasoning as
  // --mcp-notion/--mcp-monday above -- direct against Figma's own REST
  // API though, not an MCP-in walker (see prebrain/figma-comments.ts's own
  // doc comment for why). Token precedence mirrors the MCP-in walkers':
  // explicit flag, then GNT_FIGMA_TOKEN, then a locally stored `gnt
  // connect figma` token.
  figmaComments?: boolean;
  figmaToken?: string;
  // Comma-separated Figma file keys -- required alongside --figma-comments,
  // same reasoning --monday-boards documents for not auto-discovering
  // boards: there is no read here that could safely list a customer's
  // files.
  figmaFiles?: string;
  // Datadog notebooks walker: opt-in boolean, same
  // "never run just because a credential happens to be configured"
  // reasoning as --mcp-notion/--figma-comments above -- direct against
  // Datadog's own REST API, not an MCP-in walker (see
  // prebrain/datadog-notebooks.ts's own doc comment for why). Datadog
  // needs two secrets, not one token, so --datadog-api-key/--datadog-app-key
  // both override the stored/env credential, and --datadog-site overrides
  // which Datadog region to call (defaults to datadoghq.com).
  datadogNotebooks?: boolean;
  datadogApiKey?: string;
  datadogAppKey?: string;
  datadogSite?: string;
  // Comma-separated Datadog notebook ids -- required alongside
  // --datadog-notebooks, same reasoning --monday-boards/--figma-files
  // document for not auto-discovering: this walker never lists a
  // customer's notebooks as part of a run.
  datadogNotebookIds?: string;
  // Airtable connector: opt-in boolean, same
  // "never run just because a credential happens to be configured"
  // reasoning as --mcp-notion/--figma-comments/--datadog-notebooks above --
  // direct against Airtable's own REST API, not an MCP-in walker (see
  // prebrain/airtable.ts's own doc comment for why). Unlike every other
  // connector here, this one has no scope flags at all: which base, which
  // tables, and which fields are safe prose were all picked once,
  // interactively, in `gnt connect airtable`, against that base's real live
  // schema, and are read back from the saved connection -- there is
  // nothing left to pass per run except an optional token override.
  // --airtable-token overrides just the stored token; the base/tables/
  // fields selection has no per-run override on purpose (see
  // prebrain/airtable.ts's walkAirtable doc comment).
  airtable?: boolean;
  airtableToken?: string;
  // GitLab threads walker: opt-in boolean, same
  // "never run just because a token happens to be configured" reasoning as
  // --figma-comments/--datadog-notebooks above -- direct against GitLab's
  // own REST API, not an MCP-in walker (see prebrain/gitlab-threads.ts's
  // own doc comment for why). GitLab needs a token plus an optional
  // instance base URL, so --gitlab-token/--gitlab-url both override the
  // stored/env credential, the same two-value shape --datadog-api-key/
  // --datadog-site already use.
  gitlabThreads?: boolean;
  gitlabToken?: string;
  gitlabUrl?: string;
  // Comma-separated GitLab project ids or "namespace/project" paths --
  // required alongside --gitlab-threads, same reasoning --monday-boards/
  // --figma-files document for not auto-discovering: this walker never
  // lists a customer's projects or groups, only the projects named here.
  gitlabProjects?: string;
  // HubSpot notes walker: opt-in boolean, same
  // "never run just because a credential happens to be configured"
  // reasoning as --mcp-notion/--figma-comments/--datadog-notebooks above --
  // direct against HubSpot's own REST CRM API, not an MCP-in walker (see
  // prebrain/hubspot-notes.ts's own doc comment for why). This is the
  // highest-leak-risk connector in this set: it never reads
  // contact records, company records, or a deal's own fields, only a
  // note's own text, scoped to --hubspot-pipelines and/or --hubspot-teams
  // -- at least one is required, neither auto-discovers anything.
  hubspotNotes?: boolean;
  hubspotToken?: string;
  hubspotPipelines?: string;
  hubspotTeams?: string;
  // Skips the "about to open N PRs" confirmation prompt below (see
  // confirmOpenPrs/printBatchPreview) -- the escape hatch for CI/scripted
  // runs, same reasoning connect-hermes.ts's own y/N gate needs a TTY at
  // all: an unattended run has nobody there to answer it. Doesn't skip
  // the earlier company-profile Q&A (collectProfile) -- that's a separate,
  // pre-existing interactive step this flag was never asked to touch.
  yes?: boolean;
}

// Injectable seams for the two pieces of this pipeline that talk to
// something other than gnt's own API: the interactive profile pass
// (real stdin/stdout in production) and extraction (a real cloud/local
// model call in production). Everything else in this file talks to
// API_URL through the global `fetch`, which tests mock directly (same
// convention as commands/gaps.ts/review.ts) -- no injection needed there.
// `prebrain` (the real command, wired into index.ts) always uses
// DEFAULT_DEPS; tests call `runPrebrain` directly with fakes so a test run
// never touches a real terminal or a real model.
export interface PrebrainDeps {
  collectProfile: () => Promise<CompanyProfile>;
  collectSourcePicker: () => Promise<SourcePickerFields>;
  extract: typeof extractRules;
  // The "about to open N PRs -- continue?" gate (see printBatchPreview/
  // runPrebrain below) -- same injectable-seam treatment as collectProfile/
  // collectSourcePicker above, for the same reason: a test run must never
  // block on a real terminal. Takes the already-formatted prompt string and
  // resolves to whether the caller confirmed. Real entry point is
  // readYesNo below (TTY-guarded, mirrors connect-hermes.ts/
  // connect-openclaw.ts's own y/N readline helper).
  confirmOpenPrs: (prompt: string) => Promise<boolean>;
  // Live, network-calling walkers get the same injectable-seam treatment
  // as collectProfile/extract above, for the same reason: a test run must
  // never spawn a real MCP server subprocess. See test/prebrain/prebrain.test.ts
  // for the fakes.
  walkMcpNotion: (options: WalkMcpNotionOptions) => Promise<PrebrainChunk[]>;
  walkMcpMonday: (options: WalkMcpMondayOptions) => Promise<PrebrainChunk[]>;
  walkMcpLinear: (options: WalkMcpLinearOptions) => Promise<PrebrainChunk[]>;
  walkMcpJira: (options: WalkMcpJiraOptions) => Promise<PrebrainChunk[]>;
  walkMcpSentry: (options: WalkMcpSentryOptions) => Promise<PrebrainChunk[]>;
  walkMcpGranola: (options: WalkMcpGranolaOptions) => Promise<PrebrainChunk[]>;
  walkMcpZoom: (options: WalkMcpZoomOptions) => Promise<PrebrainChunk[]>;
  walkFigmaComments: (options: WalkFigmaCommentsOptions) => Promise<PrebrainChunk[]>;
  walkDatadogNotebooks: (options: WalkDatadogNotebooksOptions) => Promise<PrebrainChunk[]>;
  walkGitlabThreads: (options: WalkGitlabThreadsOptions) => Promise<PrebrainChunk[]>;
  walkHubspotNotes: (options: WalkHubspotNotesOptions) => Promise<PrebrainChunk[]>;
  walkAirtable: (options: WalkAirtableOptions) => Promise<PrebrainChunk[]>;
}

// Real confirmOpenPrs backing: same shape as connect-hermes.ts's/
// connect-openclaw.ts's own local y/N readline helper (fresh interface per
// prompt, closed immediately after) -- rejects instead of hanging when
// there's no real terminal, so an unattended run fails loudly with "pass
// --yes" instead of blocking on stdin forever.
function readYesNo(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return Promise.reject(
      new Error("gnt prebrain needs an interactive terminal to confirm opening PRs -- pass --yes to skip this prompt."),
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

const DEFAULT_DEPS: PrebrainDeps = {
  collectProfile: runCompanyProfile,
  collectSourcePicker: runSourcePicker,
  extract: extractRules,
  confirmOpenPrs: readYesNo,
  walkMcpNotion,
  walkMcpMonday,
  walkMcpLinear,
  walkMcpJira,
  walkMcpSentry,
  walkMcpGranola,
  walkMcpZoom,
  walkFigmaComments,
  walkDatadogNotebooks,
  walkGitlabThreads,
  walkHubspotNotes,
  walkAirtable,
};

const WALKER_LABELS: Record<PrebrainWalker, string> = {
  "repo-scan": "repo scan",
  "docs-dir": "docs directory",
  "notion-export": "Notion export",
  "mcp-notion": "Notion (live MCP)",
  "mcp-monday": "monday.com (live MCP)",
  "mcp-linear": "Linear (live MCP)",
  "mcp-jira": "Jira (live MCP)",
  "mcp-sentry": "Sentry (live MCP)",
  "mcp-granola": "Granola (live MCP)",
  "mcp-zoom": "Zoom (live MCP)",
  "gmail-export": "Gmail export",
  "outlook-export": "Outlook export",
  "figma-comments": "Figma comments",
  "datadog-notebooks": "Datadog notebooks",
  "hubspot-notes": "HubSpot notes",
  "meeting-notes-export": "Meeting notes export",
  "gitlab-threads": "GitLab threads",
  airtable: "Airtable",
};

const WALKER_ORDER: PrebrainWalker[] = [
  "repo-scan",
  "docs-dir",
  "notion-export",
  "mcp-notion",
  "mcp-monday",
  "mcp-linear",
  "mcp-jira",
  "mcp-sentry",
  "mcp-granola",
  "mcp-zoom",
  "gmail-export",
  "outlook-export",
  "meeting-notes-export",
  "figma-comments",
  "datadog-notebooks",
  "gitlab-threads",
  "hubspot-notes",
  "airtable",
];

// Batch size target: 5-8 rules per PR grouped by topic, small enough for a
// human to actually review in one sitting. MAX_BATCH_SIZE is enforced (a topic
// bucket bigger than this splits into more than one PR); MIN_BATCH_SIZE
// is a target, not a floor -- see groupByTopic's own comment for why a
// small, topic-pure batch is preferred over padding it with unrelated
// rules just to hit 5.
const MAX_BATCH_SIZE = 8;

const REQUEST_TIMEOUT_MS = 10_000;

// Validates --docs/--notion up front so a bad path gets one clear message
// instead of silently producing zero chunks from that walker -- the
// walkers themselves also handle a missing path defensively (see
// docs-dir.ts, notion-export.ts), this is just about a better message when
// the caller typed the flag but got the path wrong.
function resolveInputs(options: PrebrainOptions): PrebrainOptions {
  const resolved: PrebrainOptions = {};

  if (options.docs) {
    if (existsSync(options.docs) && statSync(options.docs).isDirectory()) {
      resolved.docs = options.docs;
    } else {
      console.log(fail(`--docs path not found or not a directory, skipping: ${options.docs}`));
    }
  }

  if (options.notion) {
    if (existsSync(options.notion) && statSync(options.notion).isFile()) {
      resolved.notion = options.notion;
    } else {
      console.log(fail(`--notion path not found, skipping: ${options.notion}`));
    }
  }

  if (options.gmail) {
    if (existsSync(options.gmail) && statSync(options.gmail).isFile()) {
      resolved.gmail = options.gmail;
    } else {
      console.log(fail(`--gmail path not found, skipping: ${options.gmail}`));
    }
  }
  // gmailSince/gmailUntil/gmailFrom pass through unvalidated here -- a bad
  // date string is treated as a hard error, not silently ignored, so a
  // typo can't accidentally widen an intentionally scoped-down run back
  // to the whole mailbox. See resolveGmailFilterOptions below, called
  // from collectChunks only once --gmail itself is confirmed present.
  resolved.gmailSince = options.gmailSince;
  resolved.gmailUntil = options.gmailUntil;
  resolved.gmailFrom = options.gmailFrom;

  if (options.outlook) {
    // Unlike --gmail (always a single .mbox file), --outlook accepts
    // either a directory (of .eml files) or a single file (mbox-shaped or
    // one standalone .eml) -- see outlook-export.ts's own doc comment for
    // why both shapes are real. Valid if the path exists at all; the
    // walker itself sniffs which of the two it got.
    if (existsSync(options.outlook)) {
      resolved.outlook = options.outlook;
    } else {
      console.log(fail(`--outlook path not found, skipping: ${options.outlook}`));
    }
  }
  // Same "hard error, not a silent widen" reasoning as gmailSince/
  // gmailUntil/gmailFrom above -- see resolveOutlookFilterOptions below.
  resolved.outlookSince = options.outlookSince;
  resolved.outlookUntil = options.outlookUntil;
  resolved.outlookFrom = options.outlookFrom;

  if (options.meetingNotes) {
    // Accepts either shape, like --outlook -- valid if the path exists at
    // all; the walker itself sniffs directory vs. single file, and each
    // file's own content (not its extension) for VTT/SRT vs. plain text.
    if (existsSync(options.meetingNotes)) {
      resolved.meetingNotes = options.meetingNotes;
    } else {
      console.log(fail(`--meeting-notes path not found, skipping: ${options.meetingNotes}`));
    }
  }

  // No filesystem to validate for these -- live MCP options pass straight
  // through, same as mode/apiKey/starterPacks (read off rawOptions
  // directly further down, not this function's output at all).
  resolved.mcpNotion = options.mcpNotion;
  resolved.notionMcpToken = options.notionMcpToken;
  resolved.mcpMonday = options.mcpMonday;
  resolved.mondayMcpToken = options.mondayMcpToken;
  resolved.mondayBoards = options.mondayBoards;
  resolved.mcpLinear = options.mcpLinear;
  resolved.linearMcpToken = options.linearMcpToken;
  resolved.linearTeams = options.linearTeams;
  resolved.linearProjects = options.linearProjects;
  resolved.mcpJira = options.mcpJira;
  resolved.jiraMcpToken = options.jiraMcpToken;
  resolved.jiraCloudId = options.jiraCloudId;
  resolved.jiraProjects = options.jiraProjects;
  resolved.mcpSentry = options.mcpSentry;
  resolved.sentryMcpToken = options.sentryMcpToken;
  resolved.sentryOrg = options.sentryOrg;
  resolved.sentryProjects = options.sentryProjects;
  resolved.mcpGranola = options.mcpGranola;
  resolved.granolaFolders = options.granolaFolders;
  resolved.mcpZoom = options.mcpZoom;
  resolved.zoomMcpToken = options.zoomMcpToken;
  resolved.zoomHosts = options.zoomHosts;
  resolved.zoomFrom = options.zoomFrom;
  resolved.zoomTo = options.zoomTo;
  resolved.figmaComments = options.figmaComments;
  resolved.figmaToken = options.figmaToken;
  resolved.figmaFiles = options.figmaFiles;
  resolved.datadogNotebooks = options.datadogNotebooks;
  resolved.datadogApiKey = options.datadogApiKey;
  resolved.datadogAppKey = options.datadogAppKey;
  resolved.datadogSite = options.datadogSite;
  resolved.datadogNotebookIds = options.datadogNotebookIds;
  resolved.gitlabThreads = options.gitlabThreads;
  resolved.gitlabToken = options.gitlabToken;
  resolved.gitlabUrl = options.gitlabUrl;
  resolved.gitlabProjects = options.gitlabProjects;
  resolved.hubspotNotes = options.hubspotNotes;
  resolved.hubspotToken = options.hubspotToken;
  resolved.hubspotPipelines = options.hubspotPipelines;
  resolved.hubspotTeams = options.hubspotTeams;
  resolved.airtable = options.airtable;
  resolved.airtableToken = options.airtableToken;

  // --all forces every connector's own opt-in boolean on, after the
  // individual pass-throughs above so it can't be shadowed by an unset
  // options.mcpNotion etc. -- see this function's own PrebrainOptions doc
  // comment on --all for why this never touches a scope flag.
  if (options.all) {
    resolved.mcpNotion = true;
    resolved.mcpMonday = true;
    resolved.mcpLinear = true;
    resolved.mcpJira = true;
    resolved.mcpSentry = true;
    resolved.mcpGranola = true;
    // --mcp-zoom deliberately excluded from --all: it only works for
    // recording transcripts on a paid Zoom Pro+ plan (cloud recording
    // isn't on the free Basic tier at all), so silently turning it on
    // would fail confusingly for anyone on Basic. Stays an explicit,
    // opt-in-only flag -- a customer who reaches for --mcp-zoom already
    // knows they're trying Zoom specifically.
    resolved.figmaComments = true;
    resolved.datadogNotebooks = true;
    resolved.gitlabThreads = true;
    resolved.hubspotNotes = true;
    resolved.airtable = true;
  }

  return resolved;
}

// Parses --gmail-since/--gmail-until/--gmail-from into the shape
// walkGmailExport takes. A malformed date is a hard error (the walker is
// skipped entirely, not run unscoped) -- see resolveInputs's own comment
// on why a typo here must never silently widen scope back to the whole
// mailbox.
function resolveGmailFilterOptions(options: PrebrainOptions): { value: WalkGmailExportOptions } | { error: string } {
  const value: WalkGmailExportOptions = {};

  if (options.gmailSince) {
    const since = new Date(options.gmailSince);
    if (Number.isNaN(since.getTime())) return { error: `--gmail-since is not a valid date: ${options.gmailSince}` };
    value.since = since;
  }
  if (options.gmailUntil) {
    const until = new Date(options.gmailUntil);
    if (Number.isNaN(until.getTime())) return { error: `--gmail-until is not a valid date: ${options.gmailUntil}` };
    value.until = until;
  }
  if (options.gmailFrom) {
    value.fromFilters = options.gmailFrom
      .split(",")
      .map((f) => f.trim().toLowerCase())
      .filter(Boolean);
  }

  return { value };
}

// Parses --outlook-since/--outlook-until/--outlook-from into the shape
// walkOutlookExport takes -- identical logic to resolveGmailFilterOptions
// above, mirrored rather than shared behind a helper since each function's
// error strings need to name their own flag.
function resolveOutlookFilterOptions(
  options: PrebrainOptions,
): { value: WalkOutlookExportOptions } | { error: string } {
  const value: WalkOutlookExportOptions = {};

  if (options.outlookSince) {
    const since = new Date(options.outlookSince);
    if (Number.isNaN(since.getTime())) return { error: `--outlook-since is not a valid date: ${options.outlookSince}` };
    value.since = since;
  }
  if (options.outlookUntil) {
    const until = new Date(options.outlookUntil);
    if (Number.isNaN(until.getTime())) return { error: `--outlook-until is not a valid date: ${options.outlookUntil}` };
    value.until = until;
  }
  if (options.outlookFrom) {
    value.fromFilters = options.outlookFrom
      .split(",")
      .map((f) => f.trim().toLowerCase())
      .filter(Boolean);
  }

  return { value };
}

// Live MCP sources never run just because a token happens to be
// configured -- gated on their own boolean flag, erring toward opt-in
// rather than silently attempting a live connection on every gnt prebrain
// run, unlike --docs/--notion which run whenever a path is passed. A connection or
// auth failure here is reported and that source is skipped, never fatal
// to the rest of the run -- repo-scan/docs-dir/notion-export (and the
// other MCP walkers) still complete normally, same graceful-degradation
// bias runPrebrain's own ExtractionError handling already applies.
async function collectChunks(options: PrebrainOptions, deps: PrebrainDeps): Promise<PrebrainChunk[]> {
  const chunks: PrebrainChunk[] = [];

  chunks.push(...(await walkRepoScan()));
  if (options.docs) chunks.push(...(await walkDocsDir(options.docs)));
  if (options.notion) chunks.push(...(await walkNotionExport(options.notion)));

  if (options.gmail) {
    const filters = resolveGmailFilterOptions(options);
    if ("error" in filters) {
      console.log(fail(`Gmail export walker skipped: ${filters.error}`));
    } else {
      chunks.push(...(await walkGmailExport(options.gmail, filters.value)));
    }
  }

  if (options.outlook) {
    const filters = resolveOutlookFilterOptions(options);
    if ("error" in filters) {
      console.log(fail(`Outlook export walker skipped: ${filters.error}`));
    } else {
      chunks.push(...(await walkOutlookExport(options.outlook, filters.value)));
    }
  }

  if (options.meetingNotes) {
    chunks.push(...(await walkMeetingNotesExport(options.meetingNotes)));
  }

  if (options.mcpNotion) {
    try {
      const storedToken = loadMcpToken("notion-mcp") ?? (await bootstrapDashboardToken(notionAdapter));
      chunks.push(
        ...(await deps.walkMcpNotion({
          token: options.notionMcpToken,
          storedToken,
        })),
      );
    } catch (err) {
      console.log(fail(`Notion MCP walker skipped: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  if (options.mcpMonday) {
    const boardIds = (options.mondayBoards ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (boardIds.length === 0) {
      console.log(fail("--mcp-monday needs at least one board id via --monday-boards, skipping."));
    } else {
      try {
        chunks.push(
          ...(await deps.walkMcpMonday({
            token: options.mondayMcpToken,
            storedToken: loadMcpToken("monday-mcp"),
            boardIds,
          })),
        );
      } catch (err) {
        console.log(fail(`monday.com MCP walker skipped: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  if (options.mcpLinear) {
    const teamIds = splitCommaSeparatedIds(options.linearTeams);
    const projectIds = splitCommaSeparatedIds(options.linearProjects);
    if (teamIds.length === 0 && projectIds.length === 0) {
      console.log(
        fail("--mcp-linear needs at least one team or project id via --linear-teams/--linear-projects, skipping."),
      );
    } else {
      try {
        const storedToken = loadMcpToken("linear-mcp") ?? (await bootstrapDashboardToken(linearAdapter));
        chunks.push(
          ...(await deps.walkMcpLinear({
            token: options.linearMcpToken,
            storedToken,
            teamIds,
            projectIds,
          })),
        );
      } catch (err) {
        console.log(fail(`Linear MCP walker skipped: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  if (options.mcpJira) {
    const projectKeys = splitCommaSeparatedIds(options.jiraProjects);
    if (!options.jiraCloudId || projectKeys.length === 0) {
      console.log(fail("--mcp-jira needs --jira-cloud-id and at least one project via --jira-projects, skipping."));
    } else {
      try {
        chunks.push(
          ...(await deps.walkMcpJira({
            token: options.jiraMcpToken,
            storedToken: loadMcpToken("jira-mcp"),
            cloudId: options.jiraCloudId,
            projectKeys,
          })),
        );
      } catch (err) {
        console.log(fail(`Jira MCP walker skipped: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  if (options.mcpSentry) {
    const projectSlugs = (options.sentryProjects ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (!options.sentryOrg || projectSlugs.length === 0) {
      console.log(fail("--mcp-sentry needs --sentry-org and at least one project via --sentry-projects, skipping."));
    } else {
      try {
        chunks.push(
          ...(await deps.walkMcpSentry({
            token: options.sentryMcpToken,
            storedToken: loadMcpToken("sentry-mcp"),
            organizationSlug: options.sentryOrg,
            projectSlugs,
          })),
        );
      } catch (err) {
        console.log(fail(`Sentry MCP walker skipped: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  if (options.mcpGranola) {
    const folderIds = (options.granolaFolders ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (folderIds.length === 0) {
      console.log(fail("--mcp-granola needs at least one folder id via --granola-folders, skipping."));
    } else {
      try {
        chunks.push(
          ...(await deps.walkMcpGranola({
            // No explicit-token option here on purpose -- see PrebrainOptions'
            // own comment on mcpGranola above. Only the value gnt connect
            // granola-mcp stored (a placeholder, not a real credential --
            // see mcp-granola.ts) resolves this walker's token.
            storedToken: loadMcpToken("granola-mcp"),
            folderIds,
          })),
        );
      } catch (err) {
        console.log(fail(`Granola MCP walker skipped: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  if (options.mcpZoom) {
    const hosts = splitCommaSeparatedIds(options.zoomHosts);
    if (hosts.length === 0) {
      console.log(fail("--mcp-zoom needs at least one host via --zoom-hosts, skipping."));
    } else {
      try {
        chunks.push(
          ...(await deps.walkMcpZoom({
            token: options.zoomMcpToken,
            storedToken: loadMcpToken("zoom-mcp"),
            hosts,
            from: options.zoomFrom,
            to: options.zoomTo,
          })),
        );
      } catch (err) {
        console.log(fail(`Zoom MCP walker skipped: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  if (options.figmaComments) {
    const fileKeys = (options.figmaFiles ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean);
    if (fileKeys.length === 0) {
      console.log(fail("--figma-comments needs at least one file key via --figma-files, skipping."));
    } else {
      try {
        chunks.push(
          ...(await deps.walkFigmaComments({
            token: options.figmaToken,
            storedToken: loadMcpToken(FIGMA_TOKEN_ID),
            fileKeys,
          })),
        );
      } catch (err) {
        console.log(fail(`Figma comments walker skipped: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  if (options.datadogNotebooks) {
    const notebookIds = splitCommaSeparatedIds(options.datadogNotebookIds);
    if (notebookIds.length === 0) {
      console.log(fail("--datadog-notebooks needs at least one notebook id via --datadog-notebook-ids, skipping."));
    } else {
      try {
        chunks.push(
          ...(await deps.walkDatadogNotebooks({
            apiKey: options.datadogApiKey,
            appKey: options.datadogAppKey,
            site: options.datadogSite,
            storedCredentials: loadMcpToken(DATADOG_TOKEN_ID),
            notebookIds,
          })),
        );
      } catch (err) {
        console.log(fail(`Datadog notebooks walker skipped: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  if (options.gitlabThreads) {
    const projects = splitCommaSeparatedIds(options.gitlabProjects);
    if (projects.length === 0) {
      console.log(fail("--gitlab-threads needs at least one project via --gitlab-projects, skipping."));
    } else {
      try {
        chunks.push(
          ...(await deps.walkGitlabThreads({
            token: options.gitlabToken,
            baseUrl: options.gitlabUrl,
            storedCredentials: loadMcpToken(GITLAB_TOKEN_ID),
            projects,
          })),
        );
      } catch (err) {
        console.log(fail(`GitLab threads walker skipped: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  if (options.hubspotNotes) {
    const pipelineIds = splitCommaSeparatedIds(options.hubspotPipelines);
    const teamIds = splitCommaSeparatedIds(options.hubspotTeams);
    if (pipelineIds.length === 0 && teamIds.length === 0) {
      console.log(
        fail(
          "--hubspot-notes needs at least one pipeline via --hubspot-pipelines or at least one team via --hubspot-teams, skipping.",
        ),
      );
    } else {
      try {
        chunks.push(
          ...(await deps.walkHubspotNotes({
            token: options.hubspotToken,
            storedToken: loadMcpToken(HUBSPOT_TOKEN_ID),
            pipelineIds,
            teamIds,
          })),
        );
      } catch (err) {
        console.log(fail(`HubSpot notes walker skipped: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  if (options.airtable) {
    try {
      chunks.push(
        ...(await deps.walkAirtable({
          token: options.airtableToken,
          storedConfig: loadMcpToken(AIRTABLE_TOKEN_ID),
        })),
      );
    } catch (err) {
      console.log(fail(`Airtable walker skipped: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  return chunks;
}

// Shared comma-separated-id parsing for the scoping flags above --
// --linear-teams/--linear-projects follow the exact same "trim each id,
// drop empties" convention --monday-boards already applies inline; broken
// out here since Linear needs it twice.
function splitCommaSeparatedIds(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function repoScanBreakdown(chunks: PrebrainChunk[]): string {
  const byCategory = new Map<string, number>();
  for (const chunk of chunks) {
    const category = classifyRepoScanTarget(chunk.sourcePath) ?? "other";
    byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
  }
  return [...byCategory.entries()].map(([category, count]) => `${category} (${count})`).join(", ");
}

function summarize(chunks: PrebrainChunk[]): string[] {
  const byWalker = new Map<PrebrainWalker, PrebrainChunk[]>();
  for (const chunk of chunks) {
    const list = byWalker.get(chunk.walker) ?? [];
    list.push(chunk);
    byWalker.set(chunk.walker, list);
  }

  const lines: string[] = [];
  for (const walker of WALKER_ORDER) {
    const list = byWalker.get(walker);
    if (!list || list.length === 0) continue;

    const fileCount = new Set(list.map((c) => c.sourcePath)).size;
    const promising = list.filter((c) => c.looksLikeDecisionProse === "high").length;
    const promisingNote = promising > 0 ? muted(`, ${promising} look promising`) : "";
    lines.push(
      `  ${bold(WALKER_LABELS[walker])}: ${text(`${list.length} chunk${list.length === 1 ? "" : "s"}`)} ${muted(`across ${fileCount} file${fileCount === 1 ? "" : "s"}`)}${promisingNote}`,
    );
    if (walker === "repo-scan") {
      lines.push(`    ${dim(repoScanBreakdown(list))}`);
    }
  }
  return lines;
}

// Runs every chunk through the privacy gate before any of it reaches
// extraction -- this is the actual first real caller of the gate in this
// codebase; the gate itself existed already, but nothing invoked it until
// this command wired it in. Replaces each chunk's `text` with the gate's maskedText
// wholesale, not just for the model prompt: extraction's own excerptOf
// builds each rule's source-citation excerpt straight off chunk.text (see
// extraction/index.ts's toExtractedRule), and that excerpt ends up
// verbatim in a rule body that gets committed to the customer's git repo
// -- a raw, unmasked excerpt reaching that file would defeat the whole
// point of gating before extraction, not just gating before the prompt.
async function gateChunks(chunks: PrebrainChunk[]): Promise<PrebrainChunk[]> {
  const gated = await Promise.all(chunks.map((chunk) => applyPrivacyGate(chunk.text)));
  return chunks.map((chunk, index) => ({ ...chunk, text: gated[index].maskedText }));
}

// Mirrors extraction/index.ts's own (unexported) buildSourceString exactly
// -- pure formatting, no state, duplicated here rather than exported from
// there just to let this command bucket returned rules back to the chunk
// that produced them, for the "N chunks yielded nothing" summary below.
function chunkSourceKey(chunk: PrebrainChunk): string {
  return chunk.startLine === chunk.endLine
    ? `${chunk.sourcePath}:${chunk.startLine}`
    : `${chunk.sourcePath}:${chunk.startLine}-${chunk.endLine}`;
}

// Groups extracted rules into review-sized batches (target: 5-8 rules per
// PR grouped by topic). Heuristic: a rule's
// "dominant tag" is the first tag extraction gave it (tags are the only
// topic signal extraction produces, and the first one is whichever the
// model surfaced first for that rule -- treated as its primary topic
// rather than trying to rank/cluster tags, which would need real
// judgment this command has no model call left to spend on). Rules with
// no tags at all fall into one "untagged" bucket rather than each getting
// its own single-rule PR.
//
// Each topic bucket then splits into MAX_BATCH_SIZE-sized batches. A
// bucket bigger than 8 becomes more than one PR rather than one oversized
// one; a bucket smaller than 5 becomes its own smaller PR rather than
// getting padded out with rules from an unrelated topic just to hit the
// target -- "grouped by topic" wins over hitting the 5-8 range exactly,
// which is a target for a well-tagged run, not a hard floor this function
// enforces.
function groupByTopic(rules: ExtractedRule[]): ExtractedRule[][] {
  const byTag = new Map<string, ExtractedRule[]>();
  for (const rule of rules) {
    const tag = rule.tags[0] ?? "untagged";
    const list = byTag.get(tag) ?? [];
    list.push(rule);
    byTag.set(tag, list);
  }

  const batches: ExtractedRule[][] = [];
  for (const list of byTag.values()) {
    for (let i = 0; i < list.length; i += MAX_BATCH_SIZE) {
      batches.push(list.slice(i, i + MAX_BATCH_SIZE));
    }
  }
  return batches;
}

// Prints exactly what confirmOpenPrs is about to gate: one line per PR
// (dominant topic + rule count, groupByTopic's own bucketing) plus every
// rule title in it. This is the actual fix for the "70 chunks -> 58 rules
// -> 31 PRs opened with zero warning" gap -- a caller sees the real shape
// of the run (how many PRs, how big, what's in each) before anything
// opens, not just a rule/PR count buried in the final Summary block.
function describeBatch(group: ExtractedRule[]): string {
  const tag = group[0]?.tags[0] ?? "untagged";
  return `${tag} (${group.length} rule${group.length === 1 ? "" : "s"})`;
}

function printBatchPreview(groups: ExtractedRule[][]): void {
  const totalRules = groups.reduce((n, group) => n + group.length, 0);
  console.log();
  console.log(
    bold(`About to open ${groups.length} PR${groups.length === 1 ? "" : "s"} for ${totalRules} rule${totalRules === 1 ? "" : "s"}:`),
  );
  for (const [index, group] of groups.entries()) {
    console.log(`  ${dim(`PR ${index + 1}/${groups.length}`)} -- ${text(describeBatch(group))}`);
    for (const rule of group) {
      console.log(`    ${dim(`- ${rule.title}`)}`);
    }
  }
}

// A hung API means a hung `gnt prebrain` run -- same bound as every other
// API-calling command in this CLI (see commands/gaps.ts/review.ts).
function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function describeErrorDetail(detail: unknown, status: number): string {
  if (typeof detail === "string" && detail) return detail;
  // FastAPI's own generic validation-error responses put a list of issue
  // objects in `detail`, not a string -- stringify rather than letting a
  // template literal render it as "[object Object]" (same pattern as
  // commands/review.ts's identical helper).
  if (detail !== undefined && detail !== null) return JSON.stringify(detail);
  return `request failed (${status})`;
}

function describeNetworkError(err: unknown): string {
  const timedOut = err instanceof Error && err.name === "AbortError";
  if (timedOut) return "request timed out";
  return err instanceof Error ? err.message : String(err);
}

// One-line rename from ExtractedRule's camelCase field to CreateRuleRequest's
// wire format -- not a reshape, per extraction/types.ts's own doc comment
// on sourceCitations.
function toCreateRuleBody(rule: ExtractedRule): Record<string, unknown> {
  return {
    title: rule.title,
    body: rule.body,
    confidence: rule.confidence,
    tags: rule.tags,
    source: rule.source,
    source_citations: rule.sourceCitations,
  };
}

type RuleResult = { id: string } | { error: string };

// POST /v1/rules then POST /v1/rules/:id/submit -- draft, then straight to
// in_review, since batch-propose (like propose_rule) only accepts
// in_review rules. Failures here are per-rule and non-fatal to the rest of
// the batch: a rule that fails to create or submit is reported and
// excluded from this batch's batch-propose call rather than failing every
// other rule alongside it (same graceful-degradation bias the webhook
// rework applies server-side, for the same reason -- one bad rule
// shouldn't cost a customer the other 7 good ones in the same PR).
async function createAndSubmitRule(key: string, rule: ExtractedRule): Promise<RuleResult> {
  let createRes: Response;
  try {
    createRes = await fetchWithTimeout(`${API_URL}/v1/rules`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(toCreateRuleBody(rule)),
    });
  } catch (err) {
    return { error: `create: ${describeNetworkError(err)}` };
  }
  const createBody = await createRes.json().catch(() => null);
  if (!createRes.ok) {
    return { error: `create: ${describeErrorDetail(createBody?.detail, createRes.status)}` };
  }
  const id = createBody?.id;
  if (typeof id !== "string" || !id) {
    return { error: "create: server accepted the rule but returned no id" };
  }

  let submitRes: Response;
  try {
    submitRes = await fetchWithTimeout(`${API_URL}/v1/rules/${id}/submit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (err) {
    return { error: `submit: ${describeNetworkError(err)}` };
  }
  if (!submitRes.ok) {
    const submitBody = await submitRes.json().catch(() => null);
    return { error: `submit: ${describeErrorDetail(submitBody?.detail, submitRes.status)}` };
  }
  return { id };
}

interface BatchProposeResult {
  prNumber: number;
  prUrl: string;
  ruleIds: string[];
}

type BatchProposeOutcome = BatchProposeResult | { error: string };

async function batchPropose(key: string, ruleIds: string[]): Promise<BatchProposeOutcome> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${API_URL}/v1/rules/batch-propose`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ rule_ids: ruleIds }),
    });
  } catch (err) {
    return { error: describeNetworkError(err) };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    return { error: describeErrorDetail(body?.detail, res.status) };
  }
  const prNumber = body?.pr_number;
  const prUrl = body?.pr_url;
  if (typeof prNumber !== "number" || typeof prUrl !== "string" || !prUrl) {
    return { error: "server accepted the batch but returned no PR info" };
  }
  return { prNumber, prUrl, ruleIds };
}

// Validates --starter-packs' raw value against real pack ids (see
// prebrain/starter-packs/index.ts) and prints an unknown-id warning the
// same way resolveInputs prints a bad --docs/--notion path -- an unknown
// id is dropped, not treated as fatal, so a typo in a 3-pack list doesn't
// cost the other 2 valid packs.
function resolveStarterPackOption(rawValue: string | undefined): StarterPackSelection {
  if (!rawValue) return { rules: [], packIds: [], invalidIds: [] };

  const selection = resolveStarterPacks(rawValue);
  if (selection.invalidIds.length > 0) {
    console.log(
      fail(
        `Unknown starter pack id${selection.invalidIds.length === 1 ? "" : "s"}, skipping: ${selection.invalidIds.join(", ")} -- available packs: ${listStarterPackIds().join(", ")}`,
      ),
    );
  }
  return selection;
}

// Everything a caller downstream of runPrebrain (a future/concurrent
// confirmation gate, a test, `gnt`'s own exit code) might need to know
// about how the run actually went, beyond what already got printed to the
// terminal -- most importantly chunkFailureCount/chunkErrors, so "48
// chunks failed extraction" is real data a gate can act on (e.g. fold into
// a pre-PR confirmation prompt) instead of only ever existing as a console
// line. Every field here is a value this function already computes for its
// own console output; this is a returned mirror of that, not new state.
export interface PrebrainRunSummary {
  chunksScanned: number;
  chunksWithNoRules: number;
  chunkFailureCount: number;
  chunkErrors: string[];
  rulesExtracted: number;
  starterPackRulesAdded: number;
  prsOpened: BatchProposeResult[];
  failures: string[];
}

function hasNoSourceFlags(options: PrebrainOptions): boolean {
  return (
    !options.docs &&
    !options.notion &&
    !options.gmail &&
    !options.outlook &&
    !options.meetingNotes &&
    !options.mcpNotion &&
    !options.mcpMonday &&
    !options.mcpLinear &&
    !options.mcpJira &&
    !options.mcpSentry &&
    !options.mcpGranola &&
    !options.mcpZoom &&
    !options.figmaComments &&
    !options.datadogNotebooks &&
    !options.gitlabThreads &&
    !options.hubspotNotes &&
    !options.airtable
  );
}

export async function runPrebrain(
  rawOptions: PrebrainOptions,
  deps: PrebrainDeps = DEFAULT_DEPS,
): Promise<PrebrainRunSummary> {
  // Offer already-connected/available sources before falling back to the
  // passive flag-listing message below -- only when no source flag was
  // passed at all (an explicit flag is the operator already saying what
  // they want) and only at a real terminal (same non-interactive guard
  // collectProfile's own readLine uses, for the same reason: a piped/CI
  // stdin would leave this promise unresolved forever otherwise).
  if (hasNoSourceFlags(rawOptions) && process.stdin.isTTY) {
    const picked = await deps.collectSourcePicker();
    rawOptions = { ...rawOptions, ...picked };
  }

  const options = resolveInputs(rawOptions);
  const mode: ExtractionMode = rawOptions.mode ?? "cloud";

  if (hasNoSourceFlags(options)) {
    console.log(
      muted(
        `Only scanning this repo (${process.cwd()}) -- pass --docs <path>, --notion <path.zip>, --gmail <path.mbox>, --outlook <path>, --meeting-notes <path>, --mcp-notion, --mcp-monday, --mcp-linear, --mcp-jira, --mcp-sentry, --mcp-granola, --mcp-zoom, --figma-comments, --datadog-notebooks, --gitlab-threads, --hubspot-notes, and/or --airtable for more sources.`,
      ),
    );
    // walkRepoScan has no .git check of its own (see its own doc comment --
    // it trusts the caller to be in a real repo root), so a stray run from
    // the wrong directory silently "succeeds" with zero useful chunks
    // (or noise from whatever happens to live there, e.g. a vendored
    // virtualenv) instead of failing loudly. This is the one nudge that
    // catches it before extraction burns a model call on it.
    if (!existsSync(join(process.cwd(), ".git"))) {
      console.log(fail(`No .git found in ${process.cwd()} -- cd into your repo before running this.`));
    }
  }

  const chunks = await collectChunks(options, deps);
  const starterPacks = resolveStarterPackOption(rawOptions.starterPacks);

  if (chunks.length === 0 && starterPacks.rules.length === 0) {
    console.log(muted("No candidate chunks found -- pass --starter-packs to add curated rules instead."));
    return {
      chunksScanned: 0,
      chunksWithNoRules: 0,
      chunkFailureCount: 0,
      chunkErrors: [],
      rulesExtracted: 0,
      starterPackRulesAdded: 0,
      prsOpened: [],
      failures: [],
    };
  }

  // rules/chunkErrors/chunksWithNoRules stay at these defaults when
  // there's nothing local to scan (chunks.length === 0) -- real
  // extraction never runs in that case, only starter-pack rules (checked
  // above) carry the run.
  let rules: ExtractedRule[] = [];
  let chunkErrors: string[] = [];
  let chunksWithNoRules = 0;

  if (chunks.length > 0) {
    console.log(bold(`Found ${chunks.length} candidate chunk${chunks.length === 1 ? "" : "s"}:`));
    for (const line of summarize(chunks)) {
      console.log(line);
    }
    console.log();

    // The company-profile pass, wired in here for the first time (2.2
    // landed with nothing calling it) -- run only once there's actually
    // something to scan, so an empty repo/docs/notion combination doesn't
    // make someone answer four questions for nothing.
    const profile = await deps.collectProfile();

    console.log();
    console.log(muted("Running every chunk through the privacy gate before extraction..."));
    // Honest disclosure, not a caveat buried in docs someone has to go look
    // for: layer 3 (the local-model contextual pass) is a documented no-op
    // today -- see layer3-contextual.ts -- so what's actually running here
    // is deterministic pattern matching + NER + the amounts heuristic, not
    // the full three-layer gate the marketing copy describes. Surfacing
    // that on every run beats a reader finding out by reading source.
    console.log(dim("  (contextual pass: not yet active -- deterministic + NER + amounts only)"));
    const gatedChunks = await gateChunks(chunks);

    console.log(muted(`Extracting candidate rules (${mode} mode)...`));
    const extractionOptions: ExtractionOptions = {
      mode,
      apiKey: rawOptions.apiKey,
      aiGatewayApiKey: rawOptions.aiGatewayApiKey,
      // PrebrainProfile is deliberately loose (Record<string, unknown>, see
      // extraction/types.ts's own doc comment) so extraction doesn't hard-
      // import CompanyProfile's exact shape -- this cast is the one place
      // that bridges the two, not a sign either type is wrong.
      profile: profile as unknown as Record<string, unknown>,
      anthropicModel: rawOptions.anthropicModel,
      ollamaHost: rawOptions.ollamaHost,
      ollamaModel: rawOptions.ollamaModel,
    };

    try {
      rules = await deps.extract(gatedChunks, extractionOptions);
    } catch (err) {
      if (err instanceof ExtractionError) {
        // Some chunks failed outright (network error, bad key, a
        // schema-violating local-model response) -- keep whatever succeeded
        // rather than losing a whole run to one bad chunk (see
        // ExtractionError's own doc comment).
        rules = err.partialRules;
        chunkErrors = err.chunkErrors;
      } else {
        console.log(fail(`Extraction failed: ${err instanceof Error ? err.message : String(err)}`));
        return {
          chunksScanned: chunks.length,
          chunksWithNoRules: 0,
          chunkFailureCount: 0,
          chunkErrors: [],
          rulesExtracted: 0,
          starterPackRulesAdded: 0,
          prsOpened: [],
          failures: [`extraction: ${err instanceof Error ? err.message : String(err)}`],
        };
      }
    }

    const producedKeys = new Set(rules.map((rule) => rule.source));
    chunksWithNoRules = gatedChunks.filter((chunk) => !producedKeys.has(chunkSourceKey(chunk))).length;

    if (chunkErrors.length > 0) {
      console.log(
        fail(
          `${chunkErrors.length} of ${chunks.length} chunk${chunks.length === 1 ? "" : "s"} failed extraction -- proceeding with partial results:`,
        ),
      );
      for (const line of chunkErrors) console.log(`  ${dim(line)}`);
    }

    if (rules.length === 0) {
      // A chunk (or every chunk) yielding zero rules is expected and fine,
      // not an error -- extraction's own contract (see extraction/index.ts).
      console.log(
        muted(
          `No candidate rules extracted from ${chunks.length} chunk${chunks.length === 1 ? "" : "s"} -- that's expected if nothing here reads as a real decision.`,
        ),
      );
      // Nothing left to batch/propose unless starter packs are carrying
      // this run -- return here instead of falling through to a second,
      // redundant "nothing to propose" message below.
      if (starterPacks.rules.length === 0) {
        return {
          chunksScanned: chunks.length,
          chunksWithNoRules,
          chunkFailureCount: chunkErrors.length,
          chunkErrors,
          rulesExtracted: 0,
          starterPackRulesAdded: 0,
          prsOpened: [],
          failures: [],
        };
      }
    } else {
      console.log(
        success(
          `Extracted ${rules.length} candidate rule${rules.length === 1 ? "" : "s"} from your own sources (${chunksWithNoRules}/${chunks.length} chunks yielded nothing).`,
        ),
      );
    }
  }

  if (starterPacks.rules.length > 0) {
    console.log(
      success(
        `Added ${starterPacks.rules.length} starter-pack rule${starterPacks.rules.length === 1 ? "" : "s"} from ${starterPacks.packIds.length} pack${starterPacks.packIds.length === 1 ? "" : "s"}: ${starterPacks.packIds.join(", ")}.`,
      ),
    );
  }

  // Starter-pack rules join here, at the exact point real extraction's
  // output would otherwise go straight to grouping -- same
  // groupByTopic/create/submit/batch-propose pipeline either way, no
  // parallel path. This is also the last point "N extracted from your own
  // sources" and "M starter-pack rules added" stay distinguishable counts
  // (see the Summary block below) -- everything past this line treats
  // both as one undifferentiated batch of candidate rules, on purpose.
  //
  // Always non-empty by this point: the top-of-function guard already
  // returned if chunks and starter packs were both empty, and the return
  // just above covers the remaining zero-rules case (real chunks existed
  // but extracted nothing, and no starter packs were requested).
  const allRules = [...rules, ...starterPacks.rules];

  const groups = groupByTopic(allRules);
  console.log(muted(`Grouped into ${groups.length} batch${groups.length === 1 ? "" : "es"} for review.`));

  // The gate this whole command was missing: a real run can fan out into
  // dozens of PRs (70 extracted chunks -> 58 rules -> 31 PRs was the run
  // that exposed it) with nothing shown before they all opened. Preview
  // every batch, then require an explicit yes -- --yes (or a scripted/CI
  // caller that already knows what it's doing) skips straight past it.
  printBatchPreview(groups);
  if (rawOptions.yes) {
    console.log(muted("Skipping confirmation (--yes)."));
  } else {
    let confirmed: boolean;
    try {
      confirmed = await deps.confirmOpenPrs(
        muted(`\nOpen ${groups.length} PR${groups.length === 1 ? "" : "s"}? (y/N) `),
      );
    } catch (err) {
      // Distinct from a real "no" below -- this is a non-interactive
      // terminal that couldn't even ask, not a human declining. A plain
      // return here left a scripted/CI caller seeing exit code 0 (success)
      // while zero PRs were actually created -- same process.exit(1) a
      // TTY-missing failure already gets in connect-hermes.ts.
      console.log(fail(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
    if (!confirmed) {
      console.log(muted("Aborted -- nothing created or opened. Re-run with --yes to skip this prompt."));
      return {
        chunksScanned: chunks.length,
        chunksWithNoRules,
        chunkFailureCount: chunkErrors.length,
        chunkErrors,
        rulesExtracted: rules.length,
        starterPackRulesAdded: starterPacks.rules.length,
        prsOpened: [],
        failures: [],
      };
    }
  }

  const key = loadApiKey();
  const openedPrs: BatchProposeResult[] = [];
  const failures: string[] = [];

  for (const [index, group] of groups.entries()) {
    console.log();
    console.log(bold(`Batch ${index + 1}/${groups.length} (${group.length} rule${group.length === 1 ? "" : "s"}):`));
    const readyIds: string[] = [];
    for (const rule of group) {
      const result = await createAndSubmitRule(key, rule);
      if ("error" in result) {
        console.log(fail(`  ${rule.title}: ${result.error}`));
        failures.push(`${rule.title}: ${result.error}`);
        continue;
      }
      console.log(dim(`  ${rule.title} -- drafted and submitted`));
      readyIds.push(result.id);
    }

    if (readyIds.length === 0) {
      console.log(fail("  No rules in this batch survived create/submit -- skipping batch-propose."));
      continue;
    }

    const proposed = await batchPropose(key, readyIds);
    if ("error" in proposed) {
      console.log(fail(`  batch-propose failed: ${proposed.error}`));
      failures.push(`batch ${index + 1}: ${proposed.error}`);
      continue;
    }
    console.log(success(`  Opened PR: ${proposed.prUrl}`));
    openedPrs.push(proposed);
  }

  console.log();
  console.log(bold("Summary:"));
  console.log(`  ${text(`${chunks.length} chunk${chunks.length === 1 ? "" : "s"} scanned, ${chunksWithNoRules} yielded nothing`)}`);
  // Kept as two distinct lines, never merged into one "N rules found"
  // total -- the whole point of the starter-pack summary line is that
  // nobody reading this output can mistake generic starter content for
  // something prebrain actually found in the customer's own sources (see
  // the PR description's honesty-constraint framing).
  console.log(`  ${text(`${rules.length} candidate rule${rules.length === 1 ? "" : "s"} extracted from your own sources`)}`);
  if (starterPacks.rules.length > 0) {
    console.log(
      `  ${text(`${starterPacks.rules.length} starter-pack rule${starterPacks.rules.length === 1 ? "" : "s"} added (${starterPacks.packIds.join(", ")})`)}`,
    );
  }
  console.log(`  ${text(`${openedPrs.length} PR${openedPrs.length === 1 ? "" : "s"} opened`)}`);
  for (const pr of openedPrs) {
    console.log(`    ${dim(pr.prUrl)} ${muted(`(${pr.ruleIds.length} rule${pr.ruleIds.length === 1 ? "" : "s"})`)}`);
  }
  if (failures.length > 0) {
    console.log(fail(`  ${failures.length} failure${failures.length === 1 ? "" : "s"}:`));
    for (const line of failures) console.log(`    ${dim(line)}`);
  }

  return {
    chunksScanned: chunks.length,
    chunksWithNoRules,
    chunkFailureCount: chunkErrors.length,
    chunkErrors,
    rulesExtracted: rules.length,
    starterPackRulesAdded: starterPacks.rules.length,
    prsOpened: openedPrs,
    failures,
  };
}

// commander's own .action() type wants a void-returning (or void-Promise)
// handler -- richer callers that actually want the summary (tests, and any
// future confirmation gate) call runPrebrain directly instead, same as the
// existing test suite already does.
export async function prebrain(rawOptions: PrebrainOptions): Promise<void> {
  await runPrebrain(rawOptions, DEFAULT_DEPS);
}

#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { billing } from "./commands/billing.js";
import { connectAirtable, disconnectAirtable } from "./commands/connect-airtable.js";
import { connectDatadog, disconnectDatadog } from "./commands/connect-datadog.js";
import { connectFigma, disconnectFigma } from "./commands/connect-figma.js";
import { connectGithub } from "./commands/connect-github.js";
import { connectGitlabThreads, disconnectGitlabThreads } from "./commands/connect-gitlab-threads.js";
import { connectGranolaMcp } from "./commands/connect-granola-mcp.js";
import { connectHermes } from "./commands/connect-hermes.js";
import { connectHubspot, disconnectHubspot } from "./commands/connect-hubspot.js";
import { connectJiraMcp } from "./commands/connect-jira-mcp.js";
import { connectLinearMcp } from "./commands/connect-linear-mcp.js";
import { connectMondayMcp } from "./commands/connect-monday-mcp.js";
import { connectNotionMcp } from "./commands/connect-notion-mcp.js";
import { connectOpenclaw } from "./commands/connect-openclaw.js";
import { connectSentryMcp } from "./commands/connect-sentry-mcp.js";
import { connectSlack } from "./commands/connect-slack.js";
import { connectZoomMcp } from "./commands/connect-zoom-mcp.js";
import { disconnectGithub } from "./commands/disconnect-github.js";
import {
  disconnectGranolaMcp,
  disconnectJiraMcp,
  disconnectLinearMcp,
  disconnectMondayMcp,
  disconnectNotionMcp,
  disconnectSentryMcp,
  disconnectZoomMcp,
} from "./commands/disconnect-mcp.js";
import { gaps } from "./commands/gaps.js";
import { createKey, listKeys, revokeKey, rotateKey } from "./commands/keys.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { orgInvite, orgRemove, orgRename, orgShow } from "./commands/org.js";
import { prebrain } from "./commands/prebrain.js";
import { pull } from "./commands/pull.js";
import { review } from "./commands/review.js";
import { stale } from "./commands/stale.js";
import { status } from "./commands/status.js";
import { createWebhookToken, listWebhookTokens, revokeWebhookToken } from "./commands/webhook.js";
import { formatHelp } from "./help.js";
import { listStarterPackIds } from "./prebrain/starter-packs/index.js";
import { fail } from "./theme.js";

// Read from package.json at runtime rather than hardcoding a version
// string that would silently drift out of sync on every release.
const packageDir = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(packageDir, "../package.json"), "utf-8")) as {
  version: string;
};

const program = new Command();
program
  .name("gnt")
  .description("gnt.ai — the brain for AI companies, from your terminal.")
  .version(version)
  // Must come before any .command() calls below -- Commander copies the
  // parent's help configuration onto a subcommand at the point it's
  // created, so anything defined after this still inherits formatHelp,
  // but anything defined before it wouldn't.
  .configureHelp({ formatHelp });

program.command("login").description("Sign in and store an API key locally").action(login);
program.command("logout").description("Remove the locally stored API key").action(logout);

const connect = program.command("connect").description("Connect an app to your brain");
connect.command("slack").description("Connect a Slack workspace").action(connectSlack);
connect
  .command("github")
  .description("Connect a rules repo on GitHub via the GitHub App (fine-grained permissions, auto-managed webhook)")
  .option("--upgrade", "Move an existing PAT-connected repo over to the GitHub App")
  .option("--pat", "Use the legacy personal-access-token flow instead of the GitHub App")
  .action(connectGithub);
connect
  .command("notion-mcp")
  .description("Store a Notion integration token locally, for `gnt prebrain --mcp-notion`")
  .action(connectNotionMcp);
connect
  .command("monday-mcp")
  .description("Store a monday.com API token locally, for `gnt prebrain --mcp-monday`")
  .action(connectMondayMcp);
connect
  .command("linear-mcp")
  .description("Store a Linear API key locally, for `gnt prebrain --mcp-linear`")
  .action(connectLinearMcp);
connect
  .command("jira-mcp")
  .description("Store a Jira API token locally, for `gnt prebrain --mcp-jira`")
  .action(connectJiraMcp);
connect
  .command("sentry-mcp")
  .description("Store a Sentry User Auth Token locally, for `gnt prebrain --mcp-sentry`")
  .action(connectSentryMcp);
connect
  .command("granola-mcp")
  .description("Connect Granola's MCP server locally, for `gnt prebrain --mcp-granola`")
  .action(connectGranolaMcp);
connect
  .command("zoom-mcp")
  .description("Store a Zoom user OAuth access token locally, for `gnt prebrain --mcp-zoom`")
  .action(connectZoomMcp);
connect
  .command("figma")
  .description("Store a Figma personal access token locally, for `gnt prebrain --figma-comments`")
  .action(connectFigma);
connect
  .command("datadog")
  .description("Store a Datadog API key + application key locally, for `gnt prebrain --datadog-notebooks`")
  .action(connectDatadog);
connect
  .command("gitlab-threads")
  .description("Store a GitLab project/personal access token locally, for `gnt prebrain --gitlab-threads`")
  .action(connectGitlabThreads);
connect
  .command("hubspot")
  .description("Store a HubSpot private app access token locally, for `gnt prebrain --hubspot-notes`")
  .action(connectHubspot);
connect
  .command("airtable")
  .description(
    "Interactively pick an Airtable base, tables, and safe prose fields, for `gnt prebrain --airtable`",
  )
  .option("--airtable-base <baseId>", "Base id to connect (skips the interactive base picker)")
  .action(connectAirtable);
connect
  .command("openclaw")
  .description("Point a local OpenClaw install at gnt's MCP endpoint, so it calls check_action before it acts")
  .action(connectOpenclaw);
connect
  .command("hermes")
  .description("Point a local Hermes Agent install at gnt's MCP endpoint")
  .action(connectHermes);

const disconnect = program.command("disconnect").description("Remove a locally stored connection");
disconnect
  .command("github")
  .description("Remove the connected GitHub repo and stored token from your brain")
  .action(disconnectGithub);
disconnect
  .command("notion-mcp")
  .description("Remove the locally stored Notion integration token")
  .action(disconnectNotionMcp);
disconnect
  .command("monday-mcp")
  .description("Remove the locally stored monday.com API token")
  .action(disconnectMondayMcp);
disconnect
  .command("linear-mcp")
  .description("Remove the locally stored Linear API key")
  .action(disconnectLinearMcp);
disconnect
  .command("jira-mcp")
  .description("Remove the locally stored Jira API token")
  .action(disconnectJiraMcp);
disconnect
  .command("sentry-mcp")
  .description("Remove the locally stored Sentry User Auth Token")
  .action(disconnectSentryMcp);
disconnect
  .command("granola-mcp")
  .description("Remove the locally stored Granola MCP connection")
  .action(disconnectGranolaMcp);
disconnect
  .command("zoom-mcp")
  .description("Remove the locally stored Zoom user OAuth access token")
  .action(disconnectZoomMcp);
disconnect
  .command("figma")
  .description("Remove the locally stored Figma personal access token")
  .action(disconnectFigma);
disconnect
  .command("datadog")
  .description("Remove the locally stored Datadog API key and application key")
  .action(disconnectDatadog);
disconnect
  .command("gitlab-threads")
  .description("Remove the locally stored GitLab access token")
  .action(disconnectGitlabThreads);
disconnect
  .command("hubspot")
  .description("Remove the locally stored HubSpot private app access token")
  .action(disconnectHubspot);
disconnect
  .command("airtable")
  .description("Remove the locally stored Airtable token, base, and field selection")
  .action(disconnectAirtable);

program.command("status").description("Show brain status").action(status);

program
  .command("billing")
  .description("Subscribe or manage your subscription")
  .action(billing);

program
  .command("review")
  .description("Review rules awaiting approval")
  .action(review);

program
  .command("pull")
  .description("Download the latest skill pack")
  .action(pull);

program
  .command("gaps")
  .description("List uncovered queries with no approved rule")
  .action(gaps);

program
  .command("prebrain")
  .description("Scan local sources, extract candidate rules, and open them as batched draft PRs")
  .option("--docs <path>", "Directory of docs to scan (markdown/text)")
  .option("--notion <path>", 'Path to a Notion "Markdown & CSV" export .zip')
  .option("--gmail <path>", "Path to a Google Takeout mail export (.mbox)")
  .option(
    "--gmail-since <date>",
    "Only include Gmail export messages on or after this date (YYYY-MM-DD); skips the walker if unparseable",
  )
  .option(
    "--gmail-until <date>",
    "Only include Gmail export messages on or before this date (YYYY-MM-DD); skips the walker if unparseable",
  )
  .option(
    "--gmail-from <domains-or-addresses>",
    "Comma-separated sender domains/addresses to include from --gmail (e.g. acme.com,person@acme.com)",
  )
  .option(
    "--outlook <path>",
    "Path to an Outlook export: a directory of .eml files, or a single mbox-shaped file (PST is not supported)",
  )
  .option(
    "--outlook-since <date>",
    "Only include Outlook export messages on or after this date (YYYY-MM-DD); skips the walker if unparseable",
  )
  .option(
    "--outlook-until <date>",
    "Only include Outlook export messages on or before this date (YYYY-MM-DD); skips the walker if unparseable",
  )
  .option(
    "--outlook-from <domains-or-addresses>",
    "Comma-separated sender domains/addresses to include from --outlook (e.g. acme.com,person@acme.com)",
  )
  .option(
    "--meeting-notes <path>",
    "Path to a directory or file of meeting-transcript exports from Otter, Fireflies, or Fathom (VTT/SRT cue files or plain-text transcripts, auto-detected)",
  )
  .option("--mode <mode>", 'Extraction mode: "cloud" (Anthropic) or "local" (Ollama)', "cloud")
  .option("--api-key <key>", "Anthropic API key for cloud extraction (overrides ANTHROPIC_API_KEY)")
  .option(
    "--ai-gateway-api-key <key>",
    "Vercel AI Gateway key for cloud extraction, with zero-data-retention (overrides AI_GATEWAY_API_KEY; wins over --api-key/ANTHROPIC_API_KEY when set)",
  )
  .option("--anthropic-model <name>", "Override the cloud extraction model")
  .option("--ollama-host <url>", "Local Ollama daemon host for local-mode extraction")
  .option("--ollama-model <name>", "Override the local extraction model")
  .option(
    "--starter-packs <topics>",
    `Add curated, editable starter-pack rules through the same draft-PR flow -- for orgs whose local sources are thin. "all", or a comma-separated list. Available: ${listStarterPackIds().join(", ")}`,
  )
  .option(
    "--all",
    "Turn on every connector below at once (Notion, monday.com, Linear, Jira, Sentry, Granola, Zoom, Figma, " +
      "Datadog, GitLab, HubSpot, Airtable), instead of listing each --mcp-x/--x flag by name. Only enables a " +
      "connector -- a scope flag it needs (e.g. --gitlab-projects, --hubspot-pipelines, --datadog-notebook-ids) " +
      "still has to be passed too, or that connector skips with its own message same as always",
  )
  .option(
    "--mcp-notion",
    "Also read live from your Notion workspace via its MCP server (opt-in; run `gnt connect notion-mcp` first, or pass --notion-mcp-token)",
  )
  .option("--notion-mcp-token <token>", "Notion integration token for --mcp-notion (overrides stored/env token)")
  .option(
    "--mcp-monday",
    "Also read live from monday.com via its MCP server (opt-in; run `gnt connect monday-mcp` first, or pass --monday-mcp-token; requires --monday-boards)",
  )
  .option("--monday-mcp-token <token>", "monday.com API token for --mcp-monday (overrides stored/env token)")
  .option("--monday-boards <ids>", "Comma-separated monday.com board ids to read with --mcp-monday")
  .option(
    "--mcp-linear",
    "Also read live from Linear via its MCP server (opt-in; run `gnt connect linear-mcp` first, or pass --linear-mcp-token; requires --linear-teams and/or --linear-projects)",
  )
  .option("--linear-mcp-token <token>", "Linear API key for --mcp-linear (overrides stored/env token)")
  .option("--linear-teams <ids>", "Comma-separated Linear team ids to read issues from with --mcp-linear")
  .option(
    "--linear-projects <ids>",
    "Comma-separated Linear project ids to read issues and documents from with --mcp-linear",
  )
  .option(
    "--mcp-jira",
    "Also read live from Jira via its MCP server (opt-in; run `gnt connect jira-mcp` first, or pass --jira-mcp-token; requires --jira-cloud-id and --jira-projects)",
  )
  .option("--jira-mcp-token <token>", "Jira API token for --mcp-jira (overrides stored/env token)")
  .option(
    "--jira-cloud-id <id>",
    "Atlassian site URL (https://yourteam.atlassian.net) or cloud id to read with --mcp-jira",
  )
  .option("--jira-projects <keys>", "Comma-separated Jira project keys to read issues from with --mcp-jira")
  .option(
    "--mcp-sentry",
    "Also read live issue titles/statuses from Sentry via its MCP server (opt-in; run `gnt connect sentry-mcp` first, or pass --sentry-mcp-token; requires --sentry-org and --sentry-projects)",
  )
  .option("--sentry-mcp-token <token>", "Sentry User Auth Token for --mcp-sentry (overrides stored/env token)")
  .option("--sentry-org <slug>", "Sentry organization slug to read with --mcp-sentry")
  .option("--sentry-projects <slugs>", "Comma-separated Sentry project slugs to read with --mcp-sentry")
  .option(
    "--mcp-granola",
    "Also read live from Granola via its MCP server (opt-in; requires `gnt connect granola-mcp` first -- " +
      "browser sign-in, Granola's MCP server has no token-based auth to override with a flag; requires " +
      "--granola-folders)",
  )
  .option("--granola-folders <ids>", "Comma-separated Granola folder ids to read with --mcp-granola")
  .option(
    "--mcp-zoom",
    "Also read live recording transcripts from Zoom via its MCP server (opt-in; run `gnt connect zoom-mcp` first, or pass --zoom-mcp-token; requires --zoom-hosts)",
  )
  .option("--zoom-mcp-token <token>", "Zoom user OAuth access token for --mcp-zoom (overrides stored/env token)")
  .option("--zoom-hosts <ids>", "Comma-separated Zoom host user ids or emails to read recordings from with --mcp-zoom")
  .option("--zoom-from <date>", "recordings_list date-range start, Zoom's own 'yyyy-mm-dd' format, with --mcp-zoom")
  .option("--zoom-to <date>", "recordings_list date-range end, Zoom's own 'yyyy-mm-dd' format, with --mcp-zoom")
  .option(
    "--figma-comments",
    "Also read live comment threads from your Figma files, direct against Figma's REST API (opt-in; run `gnt connect figma` first, or pass --figma-token; requires --figma-files)",
  )
  .option("--figma-token <token>", "Figma personal access token for --figma-comments (overrides stored/env token)")
  .option("--figma-files <keys>", "Comma-separated Figma file keys to read comments from with --figma-comments")
  .option(
    "--datadog-notebooks",
    "Also read live notebook titles and markdown content from Datadog, direct against its REST API (opt-in; run " +
      "`gnt connect datadog` first, or pass --datadog-api-key and --datadog-app-key; requires --datadog-notebook-ids)",
  )
  .option("--datadog-api-key <key>", "Datadog API key for --datadog-notebooks (overrides stored/env key)")
  .option("--datadog-app-key <key>", "Datadog application key for --datadog-notebooks (overrides stored/env key)")
  .option("--datadog-site <site>", "Datadog site for --datadog-notebooks, e.g. datadoghq.com or datadoghq.eu (default datadoghq.com)")
  .option("--datadog-notebook-ids <ids>", "Comma-separated Datadog notebook ids to read with --datadog-notebooks")
  .option(
    "--gitlab-threads",
    "Also read live merge request and issue discussion threads from GitLab, direct against its REST API (opt-in; run " +
      "`gnt connect gitlab-threads` first, or pass --gitlab-token; requires --gitlab-projects)",
  )
  .option("--gitlab-token <token>", "GitLab access token for --gitlab-threads (overrides stored/env token)")
  .option("--gitlab-url <url>", "GitLab instance URL for --gitlab-threads, for self-managed GitLab (default https://gitlab.com)")
  .option(
    "--gitlab-projects <ids>",
    'Comma-separated GitLab project ids or "namespace/project" paths to read discussion threads from with --gitlab-threads',
  )
  .option(
    "--hubspot-notes",
    "Also read live engagement/deal notes from HubSpot, direct against its REST CRM API (opt-in; run " +
      "`gnt connect hubspot` first, or pass --hubspot-token; requires --hubspot-pipelines and/or " +
      "--hubspot-teams; never reads contact, company, or deal record fields)",
  )
  .option("--hubspot-token <token>", "HubSpot private app access token for --hubspot-notes (overrides stored/env token)")
  .option(
    "--hubspot-pipelines <ids>",
    "Comma-separated HubSpot deal pipeline ids -- reads notes attached to deals in these pipelines with --hubspot-notes",
  )
  .option(
    "--hubspot-teams <ids>",
    "Comma-separated HubSpot team ids -- reads notes owned by these teams' members with --hubspot-notes",
  )
  .option(
    "--airtable",
    "Also read prose fields from a connected Airtable base (opt-in; run `gnt connect airtable` first -- the base, tables, and safe fields are all picked there, not via flags here)",
  )
  .option(
    "--airtable-token <token>",
    "Airtable personal access token for --airtable (overrides only the stored token; base/tables/fields always come from the saved connection)",
  )
  .option(
    "--yes",
    "Skip the confirmation prompt before opening PRs (for CI/scripted runs; the earlier company-profile questions still need a real terminal)",
  )
  .action(prebrain);

program
  .command("stale")
  .description("List approved rules due for re-validation")
  .action(stale);

const keys = program.command("keys").description("Manage MCP keys used by agents");
keys.command("list").description("List MCP keys").action(listKeys);
keys
  .command("create [name]")
  .description("Create a new MCP key")
  .action(createKey);
keys.command("revoke <id>").description("Revoke an MCP key").action(revokeKey);
keys
  .command("rotate <id>")
  .description("Replace an MCP key with a new one and revoke the old one")
  .action(rotateKey);

const webhook = program
  .command("webhook")
  .description("Manage webhook tokens for ingesting decision-prose from any tool that can send an HTTP POST");
webhook.command("list").description("List webhook tokens").action(listWebhookTokens);
webhook
  .command("create [name]")
  .description("Create a new webhook ingest URL")
  .action(createWebhookToken);
webhook.command("revoke <id>").description("Revoke a webhook token").action(revokeWebhookToken);

const org = program.command("org").description("Manage your organization");
org.command("show", { isDefault: true }).description("Show organization name, members, and pending invitations").action(orgShow);
org.command("rename <name>").description("Rename the organization").action(orgRename);
org
  .command("invite <email>")
  .description("Invite someone to the organization")
  .option("--role <role>", 'Role to invite them as: "member" or "admin"', "member")
  .action(orgInvite);
org.command("remove <email>").description("Remove someone from the organization").action(orgRemove);

function describeUnknownError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  // A thrown plain object (e.g. {status, detail} from a rejected fetch
  // helper) has useful fields String(err) would flatten to
  // "[object Object]" — stringify it instead so they survive.
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

program.parseAsync(process.argv).catch((err) => {
  console.error(fail(describeUnknownError(err)));
  process.exit(1);
});

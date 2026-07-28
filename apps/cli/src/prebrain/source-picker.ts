// The source-picker pass: offers every source `gnt prebrain` knows how to
// pull from -- already-connected or not -- before falling back to the old
// flag-listing message, instead of requiring the operator to already know
// --mcp-notion/--figma-comments/--datadog-notebooks/etc. exist AND run a
// separate `gnt connect <x>` first. Only ever runs when no source flag was
// passed at all (see runPrebrain's own gate) -- an explicit flag is still
// the operator saying exactly what they want.
//
// Picking a not-yet-connected source runs that connector's own `gnt
// connect <x>` flow inline (same token prompt/validation it always has),
// then falls straight through to pulling from it in the same run -- no
// separate command, no re-running prebrain a second time.
import { createInterface } from "node:readline";
import { loadMcpToken } from "../credentials.js";
import { hasStoredAirtableConnection } from "./airtable.js";
import { AIRTABLE_TOKEN_ID } from "./airtable.js";
import { connectAirtable } from "../commands/connect-airtable.js";
import { connectDatadog } from "../commands/connect-datadog.js";
import { connectFigma } from "../commands/connect-figma.js";
import { connectGitlabThreads } from "../commands/connect-gitlab-threads.js";
import { connectGranolaMcp } from "../commands/connect-granola-mcp.js";
import { connectHubspot } from "../commands/connect-hubspot.js";
import { connectJiraMcp } from "../commands/connect-jira-mcp.js";
import { connectLinearMcp } from "../commands/connect-linear-mcp.js";
import { connectMondayMcp } from "../commands/connect-monday-mcp.js";
import { connectNotionMcp } from "../commands/connect-notion-mcp.js";
import { connectSentryMcp } from "../commands/connect-sentry-mcp.js";
import { connectZoomMcp } from "../commands/connect-zoom-mcp.js";
import { DATADOG_TOKEN_ID } from "./datadog-notebooks.js";
import { FIGMA_TOKEN_ID } from "./figma-comments.js";
import { GITLAB_TOKEN_ID } from "./gitlab-threads.js";
import { HUBSPOT_TOKEN_ID } from "./hubspot-notes.js";
import { loadConnectorToken, MCP_IN_ADAPTERS } from "./mcp-framework/index.js";
import { askFreeText, askMultiSelect, type Ask, type Option } from "./profile.js";
import { muted } from "../theme.js";

// Whatever fields a selected source contributes to the run -- a subset of
// commands/prebrain.ts's own PrebrainOptions. Typed structurally here
// (not imported) so this module has no dependency on the command layer;
// runPrebrain spreads whatever comes back into its own options object.
export type SourcePickerFields = Record<string, string | boolean | undefined>;

export interface SourceEntry {
  key: string;
  label: string;
  // Re-checked, not cached -- an inline connect() below can flip this
  // mid-run, and the picker needs the post-connect truth before deciding
  // whether to ask this entry's own scope questions.
  isConnected: () => boolean;
  // Runs this connector's own `gnt connect <x>` flow in place. Omitted for
  // file-based entries (docs/exports), which need no connection at all --
  // "do you have one of these?" is the only availability check they get.
  connect?: () => Promise<void>;
  // Asked once this entry is connected (already was, or just got
  // connected inline).
  collect: (ask: Ask) => Promise<SourcePickerFields>;
}

async function askPath(ask: Ask, label: string): Promise<SourcePickerFields> {
  const path = await askFreeText(ask, `Path to your ${label} (blank to skip):`);
  return path ? { [label]: path } : {};
}

function mcpEntries(): SourceEntry[] {
  // id -> which boolean option this adapter's own flag sets, its connect
  // command, and the one follow-up question its scope flag needs (mirrors
  // PrebrainOptions' own field names one-for-one -- see that type's doc
  // comments for why each of these scope flags is required and never
  // auto-discovered).
  const byId: Record<
    string,
    { optionKey: string; connect: () => Promise<void>; scope?: (ask: Ask) => Promise<SourcePickerFields> }
  > = {
    "notion-mcp": { optionKey: "mcpNotion", connect: connectNotionMcp },
    "monday-mcp": {
      optionKey: "mcpMonday",
      connect: connectMondayMcp,
      scope: async (ask) => {
        const boards = await askFreeText(ask, "Comma-separated monday.com board ids:");
        return boards ? { mondayBoards: boards } : {};
      },
    },
    "linear-mcp": {
      optionKey: "mcpLinear",
      connect: connectLinearMcp,
      scope: async (ask) => {
        const teams = await askFreeText(ask, "Comma-separated Linear team ids (blank to skip):");
        const projects = await askFreeText(ask, "Comma-separated Linear project ids (blank to skip):");
        return { ...(teams ? { linearTeams: teams } : {}), ...(projects ? { linearProjects: projects } : {}) };
      },
    },
    "jira-mcp": {
      optionKey: "mcpJira",
      connect: connectJiraMcp,
      scope: async (ask) => {
        const cloudId = await askFreeText(ask, "Atlassian site URL or cloud id:");
        const projects = await askFreeText(ask, "Comma-separated Jira project keys:");
        return { ...(cloudId ? { jiraCloudId: cloudId } : {}), ...(projects ? { jiraProjects: projects } : {}) };
      },
    },
    "sentry-mcp": {
      optionKey: "mcpSentry",
      connect: connectSentryMcp,
      scope: async (ask) => {
        const org = await askFreeText(ask, "Sentry organization slug:");
        const projects = await askFreeText(ask, "Comma-separated Sentry project slugs:");
        return { ...(org ? { sentryOrg: org } : {}), ...(projects ? { sentryProjects: projects } : {}) };
      },
    },
    "granola-mcp": {
      optionKey: "mcpGranola",
      connect: connectGranolaMcp,
      scope: async (ask) => {
        const folders = await askFreeText(ask, "Comma-separated Granola folder ids:");
        return folders ? { granolaFolders: folders } : {};
      },
    },
    "zoom-mcp": {
      optionKey: "mcpZoom",
      connect: connectZoomMcp,
      scope: async (ask) => {
        const hosts = await askFreeText(ask, "Comma-separated Zoom host user ids or emails:");
        return hosts ? { zoomHosts: hosts } : {};
      },
    },
  };

  return MCP_IN_ADAPTERS.map((adapter) => {
    const spec = byId[adapter.id];
    return {
      key: adapter.id,
      label: adapter.label,
      isConnected: () => loadConnectorToken(adapter) !== undefined,
      connect: spec.connect,
      collect: async (ask) => {
        const scope = spec.scope ? await spec.scope(ask) : {};
        return { [spec.optionKey]: true, ...scope };
      },
    };
  });
}

function restEntries(): SourceEntry[] {
  return [
    {
      key: "figma",
      label: "Figma comments",
      isConnected: () => loadMcpToken(FIGMA_TOKEN_ID) !== undefined,
      connect: connectFigma,
      collect: async (ask) => {
        const files = await askFreeText(ask, "Comma-separated Figma file keys:");
        return files ? { figmaComments: true, figmaFiles: files } : {};
      },
    },
    {
      key: "datadog",
      label: "Datadog notebooks",
      isConnected: () => loadMcpToken(DATADOG_TOKEN_ID) !== undefined,
      connect: connectDatadog,
      collect: async (ask) => {
        const ids = await askFreeText(ask, "Comma-separated Datadog notebook ids:");
        return ids ? { datadogNotebooks: true, datadogNotebookIds: ids } : {};
      },
    },
    {
      key: "gitlab-threads",
      label: "GitLab merge request/issue threads",
      isConnected: () => loadMcpToken(GITLAB_TOKEN_ID) !== undefined,
      connect: connectGitlabThreads,
      collect: async (ask) => {
        const projects = await askFreeText(ask, "Comma-separated GitLab project ids or namespace/project paths:");
        return projects ? { gitlabThreads: true, gitlabProjects: projects } : {};
      },
    },
    {
      key: "hubspot",
      label: "HubSpot deal/engagement notes",
      isConnected: () => loadMcpToken(HUBSPOT_TOKEN_ID) !== undefined,
      connect: connectHubspot,
      collect: async (ask) => {
        const pipelines = await askFreeText(ask, "Comma-separated HubSpot pipeline ids (blank to skip):");
        const teams = await askFreeText(ask, "Comma-separated HubSpot team ids (blank to skip):");
        return {
          hubspotNotes: true,
          ...(pipelines ? { hubspotPipelines: pipelines } : {}),
          ...(teams ? { hubspotTeams: teams } : {}),
        };
      },
    },
    {
      key: "airtable",
      label: "Airtable",
      isConnected: () => hasStoredAirtableConnection(loadMcpToken(AIRTABLE_TOKEN_ID)),
      connect: () => connectAirtable(),
      collect: async () => ({ airtable: true }),
    },
  ];
}

// File-based sources need no connection at all, just a local export --
// always offered, no connect() -- the question itself ("do you have one of
// these?") is the availability check.
function fileEntries(): SourceEntry[] {
  return [
    { key: "docs", label: "docs folder", isConnected: () => true, collect: (ask) => askPath(ask, "docs") },
    {
      key: "notion",
      label: "Notion export (.zip)",
      isConnected: () => true,
      collect: (ask) => askPath(ask, "notion"),
    },
    {
      key: "gmail",
      label: "Gmail export (.mbox)",
      isConnected: () => true,
      collect: (ask) => askPath(ask, "gmail"),
    },
    { key: "outlook", label: "Outlook export", isConnected: () => true, collect: (ask) => askPath(ask, "outlook") },
    {
      key: "meetingNotes",
      label: "meeting notes export",
      isConnected: () => true,
      collect: (ask) => askPath(ask, "meetingNotes"),
    },
  ];
}

// Real entries in production; tests pass a fake list so picking an
// unconnected entry doesn't have to invoke a real connect-*.ts flow (a
// live token prompt/network probe) to prove the inline-connect-then-collect
// wiring works.
function buildEntries(): SourceEntry[] {
  return [...mcpEntries(), ...restEntries(), ...fileEntries()];
}

export async function collectSourcePicker(
  ask: Ask,
  entries: SourceEntry[] = buildEntries(),
): Promise<SourcePickerFields> {

  // Every entry is pickable, connected or not -- picking an unconnected one
  // just means its own `gnt connect <x>` flow runs first, inline, below.
  const options: Option<SourceEntry>[] = entries.map((e) => ({
    value: e,
    label: e.isConnected() ? e.label : `${e.label} (not connected yet)`,
  }));
  const picked = await askMultiSelect(
    ask,
    "Pull from any of these too? (comma-separated, blank to just scan this repo)",
    options,
  );
  if (picked.length === 0) return {};

  let fields: SourcePickerFields = {};
  for (const entry of picked) {
    if (!entry.isConnected()) {
      if (!entry.connect) continue;
      await runConnectWithoutExiting(entry.connect);
      if (!entry.isConnected()) {
        console.log(muted(`Skipping ${entry.label} -- still not connected.`));
        continue;
      }
    }
    fields = { ...fields, ...(await entry.collect(ask)) };
  }
  return fields;
}

class ConnectAborted extends Error {}

// Every gnt connect <x> command calls process.exit(1) on its own failure
// paths (no token entered, validation failed, etc.) -- exactly right when
// it's the whole process's top-level command, but calling one inline from
// here would kill this entire prebrain run over one failed connector
// instead of just skipping it. Swaps process.exit for the duration of the
// call so a connect command's own exit attempt throws instead of actually
// exiting; the isConnected() re-check right after this call is what
// decides whether it actually worked, same as if this override didn't
// exist. Real, unexpected exceptions instead of a plain exit(code) attempt
// still propagate -- not swallowing a genuine bug.
async function runConnectWithoutExiting(connect: () => Promise<void>): Promise<void> {
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    throw new ConnectAborted(`connect aborted (exit ${code ?? 0})`);
  }) as typeof process.exit;
  try {
    await connect();
  } catch (err) {
    if (!(err instanceof ConnectAborted)) throw err;
  } finally {
    process.exit = originalExit;
  }
}

function readLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error("gnt prebrain's source picker needs an interactive terminal."));
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function runSourcePicker(): Promise<SourcePickerFields> {
  return collectSourcePicker(readLine);
}

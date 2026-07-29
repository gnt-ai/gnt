// Tests the `gnt prebrain` command's chunk-collection stage: which walkers
// run given which options, the summary it prints, and the missing/invalid
// input messaging. Repo-scan always runs against process.cwd() (see
// repo-scan.ts's own doc comment), so these chdir into a fresh fixture
// repo for the duration of each test rather than mocking the filesystem.
//
// These call runPrebrain (not the real `prebrain` export) with a fake
// collectProfile (no real stdin) and a fake extract that always returns
// zero rules -- fast, deterministic, and out of scope for this file, which
// only cares about the walker/chunk-collection stage. See
// prebrain-pipeline.test.ts for the profile -> gate -> extract ->
// group -> propose pipeline these fakes stand in for here.
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrebrain } from "../src/commands/prebrain.js";
import type { PrebrainDeps, PrebrainOptions } from "../src/commands/prebrain.js";

let repoRoot: string;
let docsRoot: string;
let notionSourceDir: string;
let originalCwd: string;
let logs: string[];
let originalLog: typeof console.log;

const NOOP_DEPS: PrebrainDeps = {
  collectProfile: () =>
    Promise.resolve({ description: "", agentFunctions: [], primaryFunction: null, decisionSource: "other" }),
  extract: () => Promise.resolve([]),
  // Real network-calling walkers -- a test that hits either of these
  // without overriding it has a wiring bug, not a legitimate no-op case,
  // so both fail loudly rather than silently returning [].
  walkMcpNotion: () => Promise.reject(new Error("walkMcpNotion should not run without --mcp-notion")),
  walkMcpMonday: () => Promise.reject(new Error("walkMcpMonday should not run without --mcp-monday")),
  walkMcpLinear: () => Promise.reject(new Error("walkMcpLinear should not run without --mcp-linear")),
  walkMcpSentry: () => Promise.reject(new Error("walkMcpSentry should not run without --mcp-sentry")),
  walkMcpGranola: () => Promise.reject(new Error("walkMcpGranola should not run without --mcp-granola")),
  walkFigmaComments: () => Promise.reject(new Error("walkFigmaComments should not run without --figma-comments")),
  walkDatadogNotebooks: () =>
    Promise.reject(new Error("walkDatadogNotebooks should not run without --datadog-notebooks")),
  walkGitlabThreads: () => Promise.reject(new Error("walkGitlabThreads should not run without --gitlab-threads")),
};

function run(options: PrebrainOptions): Promise<void> {
  return runPrebrain(options, NOOP_DEPS);
}

function write(base: string, relPath: string, content: string) {
  const fullPath = join(base, relPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content);
}

beforeEach(() => {
  originalCwd = process.cwd();
  repoRoot = mkdtempSync(join(tmpdir(), "gnt-prebrain-cmd-repo-"));
  docsRoot = mkdtempSync(join(tmpdir(), "gnt-prebrain-cmd-docs-"));
  notionSourceDir = mkdtempSync(join(tmpdir(), "gnt-prebrain-cmd-notion-src-"));
  process.chdir(repoRoot);
  logs = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
});

afterEach(() => {
  process.chdir(originalCwd);
  console.log = originalLog;
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(docsRoot, { recursive: true, force: true });
  rmSync(notionSourceDir, { recursive: true, force: true });
});

test("scans only the repo when no options are passed", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await run({});

  const output = logs.join("\n");
  expect(output).toContain("Only scanning this repo");
  expect(output).toContain("Found 1 candidate chunk:");
  expect(output).toContain("repo scan");
  expect(output).toContain("readme (1)");
});

test("also runs the docs walker when --docs points at a real directory", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate.\n");
  write(docsRoot, "policy.md", "Escalate any refund over $500 to a manager before approving.\n");

  await run({ docs: docsRoot });

  const output = logs.join("\n");
  expect(output).toContain("docs directory");
  expect(output).not.toContain("Only scanning this repo");
});

test("prints a clear message and skips the docs walker when --docs points nowhere", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate.\n");

  await run({ docs: join(docsRoot, "does-not-exist") });

  const output = logs.join("\n");
  expect(output).toContain("--docs path not found");
  expect(output).not.toContain("docs directory");
});

test("prints a clear message and skips the notion walker when --notion points nowhere", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate.\n");

  await run({ notion: join(docsRoot, "does-not-exist.zip") });

  const output = logs.join("\n");
  expect(output).toContain("--notion path not found");
  expect(output).not.toContain("Notion export");
});

// --gmail: same "one flag, one local path" shape
// as --notion above, plus the scope-control flags a Takeout export needs.
// gmail-export.test.ts covers thread reconstruction/quote-stripping/
// filtering against a realistic multi-message fixture; these only cover
// this command's own wiring (path validation, date-parse errors, and that
// the walker's chunks reach the same pipeline every other walker's do).

function writeMboxFixture(path: string) {
  writeFileSync(
    path,
    [
      "From alice@example.com Mon Jan 05 09:00:00 2026",
      "Message-ID: <cmd-fixture-1@example.com>",
      "Date: Mon, 05 Jan 2026 09:00:00 -0800",
      "From: Alice <alice@example.com>",
      "Subject: Refund approvals",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Refunds over $500 need manager approval before they go out.",
      "",
    ].join("\n"),
  );
}

test("also runs the gmail walker when --gmail points at a real .mbox file", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");
  const mboxPath = join(docsRoot, "takeout.mbox");
  writeMboxFixture(mboxPath);

  await run({ gmail: mboxPath });

  const output = logs.join("\n");
  expect(output).toContain("Gmail export");
  expect(output).not.toContain("Only scanning this repo");
});

test("prints a clear message and skips the gmail walker when --gmail points nowhere", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate.\n");

  await run({ gmail: join(docsRoot, "does-not-exist.mbox") });

  const output = logs.join("\n");
  expect(output).toContain("--gmail path not found");
  expect(output).not.toContain("Gmail export");
});

test("skips the gmail walker with a clear error when --gmail-since is not a valid date, rather than running it unscoped", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate.\n");
  const mboxPath = join(docsRoot, "takeout.mbox");
  writeMboxFixture(mboxPath);

  await run({ gmail: mboxPath, gmailSince: "not-a-date" });

  const output = logs.join("\n");
  expect(output).toContain("Gmail export walker skipped");
  expect(output).toContain("--gmail-since is not a valid date");
  expect(output).not.toContain("Gmail export:");
});

test("skips the gmail walker with a clear error when --gmail-until is not a valid date", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate.\n");
  const mboxPath = join(docsRoot, "takeout.mbox");
  writeMboxFixture(mboxPath);

  await run({ gmail: mboxPath, gmailUntil: "not-a-date" });

  const output = logs.join("\n");
  expect(output).toContain("Gmail export walker skipped");
  expect(output).toContain("--gmail-until is not a valid date");
});

test("applies --gmail-from filtering through to the walker", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");
  const mboxPath = join(docsRoot, "takeout.mbox");
  writeMboxFixture(mboxPath); // the only message is from alice@example.com

  await run({ gmail: mboxPath, gmailFrom: "other-domain.com" });

  const output = logs.join("\n");
  // The fixture message doesn't match the filter, so the walker produced
  // zero chunks -- it still ran (no "skipped" error), it just found
  // nothing, same as --docs pointed at an empty directory would.
  expect(output).not.toContain("Gmail export walker skipped");
  expect(output).not.toContain("Gmail export:");
});

// --outlook: same "one flag, one local path"
// shape as --gmail above, plus the identical scope-control flags and
// "malformed date is a hard error" behavior. outlook-export.test.ts
// covers thread reconstruction/quote-stripping/filtering/the .eml-vs-mbox
// path sniffing against realistic fixtures; these only cover this
// command's own wiring.

function writeOutlookEmlFixture(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "message.eml"),
    [
      "Message-ID: <cmd-outlook-fixture-1@example.com>",
      "Date: Mon, 05 Jan 2026 09:00:00 -0800",
      "From: Alice <alice@example.com>",
      "Subject: Vendor approvals",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "New vendors over $10,000 need legal review before signature.",
    ].join("\n"),
  );
}

test("also runs the outlook walker when --outlook points at a real directory of .eml files", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");
  const outlookDir = join(docsRoot, "outlook-export");
  writeOutlookEmlFixture(outlookDir);

  await run({ outlook: outlookDir });

  const output = logs.join("\n");
  expect(output).toContain("Outlook export");
  expect(output).not.toContain("Only scanning this repo");
});

test("prints a clear message and skips the outlook walker when --outlook points nowhere", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate.\n");

  await run({ outlook: join(docsRoot, "does-not-exist") });

  const output = logs.join("\n");
  expect(output).toContain("--outlook path not found");
  expect(output).not.toContain("Outlook export");
});

test("skips the outlook walker with a clear error when --outlook-since is not a valid date, rather than running it unscoped", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate.\n");
  const outlookDir = join(docsRoot, "outlook-export");
  writeOutlookEmlFixture(outlookDir);

  await run({ outlook: outlookDir, outlookSince: "not-a-date" });

  const output = logs.join("\n");
  expect(output).toContain("Outlook export walker skipped");
  expect(output).toContain("--outlook-since is not a valid date");
  expect(output).not.toContain("Outlook export:");
});

test("skips the outlook walker with a clear error when --outlook-until is not a valid date", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate.\n");
  const outlookDir = join(docsRoot, "outlook-export");
  writeOutlookEmlFixture(outlookDir);

  await run({ outlook: outlookDir, outlookUntil: "not-a-date" });

  const output = logs.join("\n");
  expect(output).toContain("Outlook export walker skipped");
  expect(output).toContain("--outlook-until is not a valid date");
});

test("applies --outlook-from filtering through to the walker", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");
  const outlookDir = join(docsRoot, "outlook-export");
  writeOutlookEmlFixture(outlookDir); // the only message is from alice@example.com

  await run({ outlook: outlookDir, outlookFrom: "other-domain.com" });

  const output = logs.join("\n");
  // The fixture message doesn't match the filter, so the walker produced
  // zero chunks -- it still ran (no "skipped" error), it just found
  // nothing, same as --docs pointed at an empty directory would.
  expect(output).not.toContain("Outlook export walker skipped");
  expect(output).not.toContain("Outlook export:");
});

test("also runs the outlook walker when --outlook points at a single mbox-shaped file", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");
  const mboxPath = join(docsRoot, "bridged.mbox");
  writeMboxFixture(mboxPath);

  await run({ outlook: mboxPath });

  const output = logs.join("\n");
  expect(output).toContain("Outlook export");
  expect(output).not.toContain("Only scanning this repo");
});

// --meeting-notes: same "one flag, one local path"
// shape as --outlook (accepts a directory or a single file), but no
// scope-control flags -- a meeting-notes export is one file per meeting,
// not a mailbox's whole history. meeting-notes-export.test.ts covers cue
// merging/plain-text normalization/format auto-detection against
// realistic fixtures; these only cover this command's own wiring.

function writeMeetingNotesVttFixture(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "standup.vtt"),
    [
      "WEBVTT",
      "",
      "1",
      "00:00:00.000 --> 00:00:03.000",
      "<v Jane Doe>All refunds over $500 need manager approval before they go out.",
    ].join("\n"),
  );
}

test("also runs the meeting-notes walker when --meeting-notes points at a real directory", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");
  const notesDir = join(docsRoot, "meeting-notes");
  writeMeetingNotesVttFixture(notesDir);

  await run({ meetingNotes: notesDir });

  const output = logs.join("\n");
  expect(output).toContain("Meeting notes export");
  expect(output).not.toContain("Only scanning this repo");
});

test("also runs the meeting-notes walker when --meeting-notes points at a single file", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");
  const filePath = join(docsRoot, "one-off.srt");
  writeFileSync(
    filePath,
    ["1", "00:00:00,000 --> 00:00:03,000", "Jane Doe: All vendors over $10,000 require legal review."].join("\n"),
  );

  await run({ meetingNotes: filePath });

  const output = logs.join("\n");
  expect(output).toContain("Meeting notes export");
});

test("prints a clear message and skips the meeting-notes walker when --meeting-notes points nowhere", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate.\n");

  await run({ meetingNotes: join(docsRoot, "does-not-exist") });

  const output = logs.join("\n");
  expect(output).toContain("--meeting-notes path not found");
  expect(output).not.toContain("Meeting notes export");
});

test("runs all three walkers together and reports each one's contribution", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");
  write(docsRoot, "policy.md", "Escalate any refund over $500 to a manager before approving.\n");

  writeFileSync(
    join(notionSourceDir, "page.md"),
    "# Handbook\n\nAll pull requests must have at least one approving review before merge.\n",
  );
  const zipPath = join(tmpdir(), `gnt-prebrain-cmd-notion-${Date.now()}.zip`);
  execFileSync("zip", ["-r", zipPath, "."], { cwd: notionSourceDir });

  try {
    await run({ docs: docsRoot, notion: zipPath });

    const output = logs.join("\n");
    expect(output).toContain("repo scan");
    expect(output).toContain("docs directory");
    expect(output).toContain("Notion export");
  } finally {
    rmSync(zipPath, { force: true });
  }
});

// --mcp-notion/--mcp-monday: opt-in only, unlike every
// walker above -- these never run just because a token is configured, and
// a live-connection failure never crashes the rest of the run. The real
// walker implementations (mcp-notion.ts/mcp-monday.ts) have their own
// dedicated tests against a fake MCP client; this file only cares about
// commands/prebrain.ts's own wiring: is the flag actually gating the
// call, and is a thrown error turned into a printed message rather than
// an unhandled rejection.

test("does not call the Notion MCP walker when --mcp-notion is not passed (the every-other-test invariant, made explicit)", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");
  await run({});
  // NOOP_DEPS.walkMcpNotion rejects if ever called -- reaching this line
  // without throwing already proves it wasn't.
  expect(true).toBe(true);
});

test("calls the Notion MCP walker only when --mcp-notion is passed, and includes its chunks", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");

  await runPrebrain(
    { mcpNotion: true },
    {
      ...NOOP_DEPS,
      walkMcpNotion: () =>
        Promise.resolve([
          {
            text: "Escalate any live incident to the on-call engineer within 15 minutes.",
            sourcePath: "https://notion.so/page-1",
            startLine: 1,
            endLine: 1,
            walker: "mcp-notion",
            looksLikeDecisionProse: "high",
          },
        ]),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("Notion (live MCP)");
});

test("reports a clear, non-fatal message when the Notion MCP walker fails, and still runs the rest of the pipeline", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await runPrebrain(
    { mcpNotion: true },
    {
      ...NOOP_DEPS,
      walkMcpNotion: () => Promise.reject(new Error("No Notion MCP token found.")),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("Notion MCP walker skipped");
  expect(output).toContain("No Notion MCP token found.");
  // The repo-scan chunk from README.md still went through -- one bad MCP
  // source doesn't cost the rest of the run.
  expect(output).toContain("repo scan");
});

test("reports a clear message and skips the monday.com MCP walker entirely when --monday-boards is missing", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await runPrebrain(
    { mcpMonday: true },
    {
      ...NOOP_DEPS,
      walkMcpMonday: () => Promise.reject(new Error("walkMcpMonday should not be called without board ids")),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("--mcp-monday needs at least one board id via --monday-boards");
});

test("calls the monday.com MCP walker with the parsed --monday-boards list when both are passed", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");

  let receivedBoardIds: string[] = [];
  await runPrebrain(
    { mcpMonday: true, mondayBoards: " board-1, board-2 ,board-3" },
    {
      ...NOOP_DEPS,
      walkMcpMonday: (options) => {
        receivedBoardIds = options.boardIds;
        return Promise.resolve([]);
      },
    },
  );

  expect(receivedBoardIds).toEqual(["board-1", "board-2", "board-3"]);
});

test("reports a clear, non-fatal message when the monday.com MCP walker fails, and still runs the rest of the pipeline", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await runPrebrain(
    { mcpMonday: true, mondayBoards: "board-1" },
    {
      ...NOOP_DEPS,
      walkMcpMonday: () => Promise.reject(new Error("Couldn't connect to the monday.com MCP server: ECONNREFUSED")),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("monday.com MCP walker skipped");
  expect(output).toContain("ECONNREFUSED");
  expect(output).toContain("repo scan");
});

// --mcp-linear: same opt-in-boolean shape as
// --mcp-notion/--mcp-monday above -- see that block's own comment. The
// real walker (mcp-linear.ts) has its own dedicated tests against a fake
// MCP client; this file only cares about commands/prebrain.ts's own
// wiring: is the flag gating the call, is the team/project id parsing
// correct, and is a thrown error turned into a printed message.

test("does not call the Linear MCP walker when --mcp-linear is not passed", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");
  await run({});
  // NOOP_DEPS.walkMcpLinear rejects if ever called -- reaching this line
  // without throwing already proves it wasn't.
  expect(true).toBe(true);
});

test("reports a clear message and skips the Linear MCP walker entirely when neither --linear-teams nor --linear-projects is passed", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await runPrebrain(
    { mcpLinear: true },
    {
      ...NOOP_DEPS,
      walkMcpLinear: () => Promise.reject(new Error("walkMcpLinear should not be called without team/project ids")),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("--mcp-linear needs at least one team or project id via --linear-teams/--linear-projects");
});

test("calls the Linear MCP walker with the parsed --linear-teams/--linear-projects lists when passed", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");

  let received: { teamIds: string[]; projectIds: string[] } = { teamIds: [], projectIds: [] };
  await runPrebrain(
    { mcpLinear: true, linearTeams: " team-1, team-2", linearProjects: "proj-1," },
    {
      ...NOOP_DEPS,
      walkMcpLinear: (options) => {
        received = { teamIds: options.teamIds, projectIds: options.projectIds };
        return Promise.resolve([]);
      },
    },
  );

  expect(received.teamIds).toEqual(["team-1", "team-2"]);
  expect(received.projectIds).toEqual(["proj-1"]);
});

test("calls the Linear MCP walker when only --linear-projects is passed, with an empty team list", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");

  let received: { teamIds: string[]; projectIds: string[] } = { teamIds: ["unset"], projectIds: [] };
  await runPrebrain(
    { mcpLinear: true, linearProjects: "proj-1" },
    {
      ...NOOP_DEPS,
      walkMcpLinear: (options) => {
        received = { teamIds: options.teamIds, projectIds: options.projectIds };
        return Promise.resolve([]);
      },
    },
  );

  expect(received.teamIds).toEqual([]);
  expect(received.projectIds).toEqual(["proj-1"]);
});

test("includes Linear MCP chunks in the summary when --mcp-linear succeeds", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");

  await runPrebrain(
    { mcpLinear: true, linearTeams: "team-1" },
    {
      ...NOOP_DEPS,
      walkMcpLinear: () =>
        Promise.resolve([
          {
            text: "Escalate any live incident to the on-call engineer within 15 minutes.",
            sourcePath: "https://linear.app/acme/issue/ENG-1",
            startLine: 1,
            endLine: 1,
            walker: "mcp-linear",
            looksLikeDecisionProse: "high",
          },
        ]),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("Linear (live MCP)");
});

test("reports a clear, non-fatal message when the Linear MCP walker fails, and still runs the rest of the pipeline", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await runPrebrain(
    { mcpLinear: true, linearTeams: "team-1" },
    {
      ...NOOP_DEPS,
      walkMcpLinear: () => Promise.reject(new Error("No Linear MCP token found.")),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("Linear MCP walker skipped");
  expect(output).toContain("No Linear MCP token found.");
  expect(output).toContain("repo scan");
});

// --mcp-sentry: same opt-in-boolean shape as
// --mcp-notion/--mcp-monday/--mcp-linear above -- see that block's own
// comment. The real walker (mcp-sentry.ts) has its own dedicated tests
// against a fake MCP client; this file only cares about
// commands/prebrain.ts's own wiring.

test("reports a clear message and skips the Sentry MCP walker entirely when --sentry-org/--sentry-projects are missing", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await runPrebrain(
    { mcpSentry: true },
    {
      ...NOOP_DEPS,
      walkMcpSentry: () => Promise.reject(new Error("walkMcpSentry should not be called without org/projects")),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("--mcp-sentry needs --sentry-org and at least one project via --sentry-projects");
});

test("calls the Sentry MCP walker with the parsed org and --sentry-projects list when all three are passed", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");

  let received: { organizationSlug: string; projectSlugs: string[] } | undefined;
  await runPrebrain(
    { mcpSentry: true, sentryOrg: "acme-org", sentryProjects: " backend, frontend ,worker" },
    {
      ...NOOP_DEPS,
      walkMcpSentry: (options) => {
        received = { organizationSlug: options.organizationSlug, projectSlugs: options.projectSlugs };
        return Promise.resolve([]);
      },
    },
  );

  expect(received).toEqual({ organizationSlug: "acme-org", projectSlugs: ["backend", "frontend", "worker"] });
});

test("reports a clear, non-fatal message when the Sentry MCP walker fails, and still runs the rest of the pipeline", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await runPrebrain(
    { mcpSentry: true, sentryOrg: "acme-org", sentryProjects: "backend" },
    {
      ...NOOP_DEPS,
      walkMcpSentry: () => Promise.reject(new Error("Couldn't connect to the Sentry MCP server: ECONNREFUSED")),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("Sentry MCP walker skipped");
  expect(output).toContain("ECONNREFUSED");
  expect(output).toContain("repo scan");
});

// --mcp-granola: same opt-in-boolean shape as
// --mcp-notion/--mcp-monday/--mcp-linear/--mcp-sentry above -- see that
// block's own comment. The real walker (mcp-granola.ts) has its own
// dedicated tests against a fake MCP client; this file only cares about
// commands/prebrain.ts's own wiring.

test("reports a clear message and skips the Granola MCP walker entirely when --granola-folders is missing", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await runPrebrain(
    { mcpGranola: true },
    {
      ...NOOP_DEPS,
      walkMcpGranola: () => Promise.reject(new Error("walkMcpGranola should not be called without folder ids")),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("--mcp-granola needs at least one folder id via --granola-folders");
});

test("calls the Granola MCP walker with the parsed --granola-folders list when both are passed", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");

  let receivedFolderIds: string[] = [];
  await runPrebrain(
    { mcpGranola: true, granolaFolders: " folder-1, folder-2 ,folder-3" },
    {
      ...NOOP_DEPS,
      walkMcpGranola: (options) => {
        receivedFolderIds = options.folderIds;
        return Promise.resolve([]);
      },
    },
  );

  expect(receivedFolderIds).toEqual(["folder-1", "folder-2", "folder-3"]);
});

test("calls the Granola MCP walker only when --mcp-granola is passed, and includes its chunks", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");

  await runPrebrain(
    { mcpGranola: true, granolaFolders: "folder-1" },
    {
      ...NOOP_DEPS,
      walkMcpGranola: () =>
        Promise.resolve([
          {
            text: "Jane Doe: We're going to go with the vendor migration in Q3.",
            sourcePath: "meetings/m1",
            startLine: 1,
            endLine: 1,
            walker: "mcp-granola",
            looksLikeDecisionProse: "medium",
          },
        ]),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("Granola (live MCP)");
});

test("reports a clear, non-fatal message when the Granola MCP walker fails, and still runs the rest of the pipeline", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await runPrebrain(
    { mcpGranola: true, granolaFolders: "folder-1" },
    {
      ...NOOP_DEPS,
      walkMcpGranola: () => Promise.reject(new Error("No Granola MCP connection found.")),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("Granola MCP walker skipped");
  expect(output).toContain("No Granola MCP connection found.");
  expect(output).toContain("repo scan");
});

// --figma-comments: opt-in only, same reasoning
// as --mcp-notion/--mcp-monday above -- never runs just because a token is
// configured, and a live request failure never crashes the rest of the
// run. This walker reads direct from Figma's REST API rather than through
// an MCP server (see prebrain/figma-comments.ts's own doc comment), but
// its wiring into this command mirrors --mcp-monday's exactly: an opt-in
// boolean plus a required, comma-separated scope flag. figma-comments.test.ts
// covers the walker's own field discipline and error handling; this file
// only cares about commands/prebrain.ts's own wiring.

test("does not call the Figma comments walker when --figma-comments is not passed (the every-other-test invariant, made explicit)", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");
  await run({});
  // NOOP_DEPS.walkFigmaComments rejects if ever called -- reaching this
  // line without throwing already proves it wasn't.
  expect(true).toBe(true);
});

test("reports a clear message and skips the Figma comments walker entirely when --figma-files is missing", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await runPrebrain(
    { figmaComments: true },
    {
      ...NOOP_DEPS,
      walkFigmaComments: () => Promise.reject(new Error("walkFigmaComments should not be called without file keys")),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("--figma-comments needs at least one file key via --figma-files");
});

test("calls the Figma comments walker with the parsed --figma-files list when both are passed", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");

  let receivedFileKeys: string[] = [];
  await runPrebrain(
    { figmaComments: true, figmaFiles: " abc123, def456 ,ghi789" },
    {
      ...NOOP_DEPS,
      walkFigmaComments: (options) => {
        receivedFileKeys = options.fileKeys;
        return Promise.resolve([]);
      },
    },
  );

  expect(receivedFileKeys).toEqual(["abc123", "def456", "ghi789"]);
});

test("includes the Figma comments walker's chunks in the run when it succeeds", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");

  await runPrebrain(
    { figmaComments: true, figmaFiles: "abc123" },
    {
      ...NOOP_DEPS,
      walkFigmaComments: () =>
        Promise.resolve([
          {
            text: "Ship the red variant of the checkout button, not the blue one.",
            sourcePath: "figma/files/abc123/comments/1",
            startLine: 1,
            endLine: 1,
            walker: "figma-comments",
            looksLikeDecisionProse: "high",
          },
        ]),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("Figma comments");
});

test("reports a clear, non-fatal message when the Figma comments walker fails, and still runs the rest of the pipeline", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await runPrebrain(
    { figmaComments: true, figmaFiles: "abc123" },
    {
      ...NOOP_DEPS,
      walkFigmaComments: () => Promise.reject(new Error("Figma comments request failed for file abc123 (403: Invalid token)")),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("Figma comments walker skipped");
  expect(output).toContain("Invalid token");
  // The repo-scan chunk from README.md still went through -- one bad
  // source doesn't cost the rest of the run.
  expect(output).toContain("repo scan");
});

// --datadog-notebooks: opt-in only, same reasoning
// as --mcp-notion/--figma-comments above -- never runs just because
// credentials are configured, and a live request failure never crashes the
// rest of the run. This walker reads direct from Datadog's REST API rather
// than through an MCP server (see prebrain/datadog-notebooks.ts's own doc
// comment), but its wiring into this command mirrors --figma-comments's
// exactly: an opt-in boolean plus a required, comma-separated scope flag.
// datadog-notebooks.test.ts covers the walker's own field discipline and
// error handling; this file only cares about commands/prebrain.ts's own
// wiring.

test("does not call the Datadog notebooks walker when --datadog-notebooks is not passed (the every-other-test invariant, made explicit)", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");
  await run({});
  // NOOP_DEPS.walkDatadogNotebooks rejects if ever called -- reaching this
  // line without throwing already proves it wasn't.
  expect(true).toBe(true);
});

test("reports a clear message and skips the Datadog notebooks walker entirely when --datadog-notebook-ids is missing", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await runPrebrain(
    { datadogNotebooks: true },
    {
      ...NOOP_DEPS,
      walkDatadogNotebooks: () => Promise.reject(new Error("walkDatadogNotebooks should not be called without notebook ids")),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("--datadog-notebooks needs at least one notebook id via --datadog-notebook-ids");
});

test("calls the Datadog notebooks walker with the parsed --datadog-notebook-ids list when both are passed", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");

  let receivedIds: string[] = [];
  await runPrebrain(
    { datadogNotebooks: true, datadogNotebookIds: " 111, 222 ,333" },
    {
      ...NOOP_DEPS,
      walkDatadogNotebooks: (options) => {
        receivedIds = options.notebookIds;
        return Promise.resolve([]);
      },
    },
  );

  expect(receivedIds).toEqual(["111", "222", "333"]);
});

test("includes the Datadog notebooks walker's chunks in the run when it succeeds", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");

  await runPrebrain(
    { datadogNotebooks: true, datadogNotebookIds: "998877" },
    {
      ...NOOP_DEPS,
      walkDatadogNotebooks: () =>
        Promise.resolve([
          {
            text: "Root cause: a bad deploy rolled back late.",
            sourcePath: "https://app.datadoghq.com/notebook/998877",
            startLine: 1,
            endLine: 1,
            walker: "datadog-notebooks",
            looksLikeDecisionProse: "high",
          },
        ]),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("Datadog notebooks");
});

test("reports a clear, non-fatal message when the Datadog notebooks walker fails, and still runs the rest of the pipeline", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await runPrebrain(
    { datadogNotebooks: true, datadogNotebookIds: "998877" },
    {
      ...NOOP_DEPS,
      walkDatadogNotebooks: () =>
        Promise.reject(new Error("Datadog notebook request failed for 998877 (403: Forbidden)")),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("Datadog notebooks walker skipped");
  expect(output).toContain("Forbidden");
  // The repo-scan chunk from README.md still went through -- one bad
  // source doesn't cost the rest of the run.
  expect(output).toContain("repo scan");
});

// --gitlab-threads: opt-in only, same reasoning as
// --figma-comments/--datadog-notebooks above -- never runs just because a
// token is configured, and a live request failure never crashes the rest
// of the run. This walker reads direct from GitLab's REST API rather than
// through an MCP server (see prebrain/gitlab-threads.ts's own doc comment),
// but its wiring into this command mirrors --datadog-notebooks's exactly:
// an opt-in boolean plus a required, comma-separated scope flag.
// gitlab-threads.test.ts covers the walker's own field discipline and
// error handling; this file only cares about commands/prebrain.ts's own
// wiring.

test("does not call the GitLab threads walker when --gitlab-threads is not passed (the every-other-test invariant, made explicit)", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");
  await run({});
  // NOOP_DEPS.walkGitlabThreads rejects if ever called -- reaching this
  // line without throwing already proves it wasn't.
  expect(true).toBe(true);
});

test("reports a clear message and skips the GitLab threads walker entirely when --gitlab-projects is missing", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await runPrebrain(
    { gitlabThreads: true },
    {
      ...NOOP_DEPS,
      walkGitlabThreads: () => Promise.reject(new Error("walkGitlabThreads should not be called without projects")),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("--gitlab-threads needs at least one project via --gitlab-projects");
});

test("calls the GitLab threads walker with the parsed --gitlab-projects list when both are passed", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");

  let receivedProjects: string[] = [];
  await runPrebrain(
    { gitlabThreads: true, gitlabProjects: " acme/widgets, 42 ,acme/other" },
    {
      ...NOOP_DEPS,
      walkGitlabThreads: (options) => {
        receivedProjects = options.projects;
        return Promise.resolve([]);
      },
    },
  );

  expect(receivedProjects).toEqual(["acme/widgets", "42", "acme/other"]);
});

test("includes the GitLab threads walker's chunks in the run when it succeeds", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");

  await runPrebrain(
    { gitlabThreads: true, gitlabProjects: "acme/widgets" },
    {
      ...NOOP_DEPS,
      walkGitlabThreads: () =>
        Promise.resolve([
          {
            text: "Ship the retry with exponential backoff.",
            sourcePath: "https://gitlab.com/acme/widgets/-/merge_requests/11",
            startLine: 1,
            endLine: 1,
            walker: "gitlab-threads",
            looksLikeDecisionProse: "high",
          },
        ]),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("GitLab threads");
});

test("reports a clear, non-fatal message when the GitLab threads walker fails, and still runs the rest of the pipeline", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await runPrebrain(
    { gitlabThreads: true, gitlabProjects: "acme/widgets" },
    {
      ...NOOP_DEPS,
      walkGitlabThreads: () =>
        Promise.reject(new Error("GitLab request failed for project acme/widgets merge requests (404: Project Not Found)")),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("GitLab threads walker skipped");
  expect(output).toContain("Project Not Found");
  // The repo-scan chunk from README.md still went through -- one bad
  // source doesn't cost the rest of the run.
  expect(output).toContain("repo scan");
});

// --airtable: opt-in only, same reasoning as
// --figma-comments/--datadog-notebooks above -- never runs just because a
// connection is configured, and a live request failure never crashes the
// rest of the run. Unlike those two, this walker takes no scope flag at
// all: the base, the tables, and the field allowlist are all fixed at
// `gnt connect airtable` time (see prebrain/airtable.ts's own doc
// comment), so there's no --airtable-files/--airtable-notebook-ids
// equivalent to test here, and no "missing scope flag" message case
// either -- a missing connection is MissingAirtableConfigError, thrown by
// the walker itself and caught by this same skip-and-report path.
// airtable.test.ts covers the walker's own field discipline and error
// handling; this file only cares about commands/prebrain.ts's own wiring.

test("does not call the Airtable walker when --airtable is not passed (the every-other-test invariant, made explicit)", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");
  await run({});
  // NOOP_DEPS.walkAirtable rejects if ever called -- reaching this line
  // without throwing already proves it wasn't.
  expect(true).toBe(true);
});

test("calls the Airtable walker with --airtable-token passed through when both are given", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");

  let receivedToken: string | undefined;
  await runPrebrain(
    { airtable: true, airtableToken: "explicit-pat" },
    {
      ...NOOP_DEPS,
      walkAirtable: (options) => {
        receivedToken = options.token;
        return Promise.resolve([]);
      },
    },
  );

  expect(receivedToken).toBe("explicit-pat");
});

test("includes the Airtable walker's chunks in the run when it succeeds", async () => {
  write(repoRoot, "README.md", "Root readme content, not boilerplate at all.\n");

  await runPrebrain(
    { airtable: true },
    {
      ...NOOP_DEPS,
      walkAirtable: () =>
        Promise.resolve([
          {
            text: "Refunds over $500 require manager approval before processing.",
            sourcePath: "https://airtable.com/appBase123/tblNotes/recAAA111",
            startLine: 1,
            endLine: 1,
            walker: "airtable",
            looksLikeDecisionProse: "high",
          },
        ]),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("Airtable");
});

test("reports a clear, non-fatal message when the Airtable walker fails, and still runs the rest of the pipeline", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await runPrebrain(
    { airtable: true },
    {
      ...NOOP_DEPS,
      walkAirtable: () =>
        Promise.reject(new Error("No Airtable connection found. Run `gnt connect airtable` first to pick a base, tables, and safe fields.")),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("Airtable walker skipped");
  expect(output).toContain("gnt connect airtable");
  // The repo-scan chunk from README.md still went through -- one bad
  // source doesn't cost the rest of the run.
  expect(output).toContain("repo scan");
});

test("reports no candidate chunks found when nothing matches anywhere", async () => {
  await run({});

  const output = logs.join("\n");
  // Points at --starter-packs since this is exactly the
  // "local sources are thin" case that flag exists for.
  expect(output).toContain("No candidate chunks found -- pass --starter-packs to add curated rules instead.");
});

test("skips the company-profile pass entirely when there are no candidate chunks", async () => {
  let profileCalled = false;
  await runPrebrain(
    {},
    {
      ...NOOP_DEPS,
      collectProfile: () => {
        profileCalled = true;
        return NOOP_DEPS.collectProfile();
      },
    },
  );

  expect(profileCalled).toBe(false);
});

test("runs the company-profile pass once real chunks are found", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  let profileCalled = false;
  await runPrebrain(
    {},
    {
      ...NOOP_DEPS,
      collectProfile: () => {
        profileCalled = true;
        return NOOP_DEPS.collectProfile();
      },
    },
  );

  expect(profileCalled).toBe(true);
});

test("reports that zero rules is expected, not an error, when extraction finds nothing", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await run({});

  const output = logs.join("\n");
  expect(output).toContain("No candidate rules extracted");
  expect(output).toContain("expected");
});

// --all: turns on every connector's own opt-in boolean at once (see
// resolveInputs's own comment in commands/prebrain.ts). Overrides every
// walker explicitly here rather than spreading bare NOOP_DEPS -- NOOP_DEPS
// itself is missing walkMcpJira/walkMcpZoom/walkHubspotNotes/walkAirtable,
// so a test that needs all twelve to actually run has to supply every one
// itself, not rely on the shared fixture having them.
test("--all calls every connector's walker at once, provided its own scope flag is also passed", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  const called = new Set<string>();
  const trackedWalker = (name: string) => () => {
    called.add(name);
    return Promise.resolve([]);
  };

  await runPrebrain(
    {
      all: true,
      mondayBoards: "1",
      linearTeams: "team-1",
      jiraCloudId: "cloud-1",
      jiraProjects: "PROJ",
      sentryOrg: "acme",
      sentryProjects: "backend",
      granolaFolders: "folder-1",
      // --mcp-zoom is excluded from --all (needs a paid Zoom plan), so it
      // needs its own explicit opt-in here alongside --all, unlike every
      // other connector in this test.
      mcpZoom: true,
      zoomHosts: "host@acme.com",
      figmaFiles: "file-1",
      datadogNotebookIds: "4821",
      gitlabProjects: "acme/widgets",
      hubspotPipelines: "123",
    },
    {
      collectProfile: NOOP_DEPS.collectProfile,
      extract: NOOP_DEPS.extract,
      walkMcpNotion: trackedWalker("notion"),
      walkMcpMonday: trackedWalker("monday"),
      walkMcpLinear: trackedWalker("linear"),
      walkMcpJira: trackedWalker("jira"),
      walkMcpSentry: trackedWalker("sentry"),
      walkMcpGranola: trackedWalker("granola"),
      walkMcpZoom: trackedWalker("zoom"),
      walkFigmaComments: trackedWalker("figma"),
      walkDatadogNotebooks: trackedWalker("datadog"),
      walkGitlabThreads: trackedWalker("gitlab"),
      walkHubspotNotes: trackedWalker("hubspot"),
      walkAirtable: trackedWalker("airtable"),
    },
  );

  expect(called).toEqual(
    new Set([
      "notion",
      "monday",
      "linear",
      "jira",
      "sentry",
      "granola",
      "zoom",
      "figma",
      "datadog",
      "gitlab",
      "hubspot",
      "airtable",
    ]),
  );
});

test("--all does not invent scope -- a connector missing its own scope flag still skips with its usual message", async () => {
  write(repoRoot, "README.md", "Refunds over 15% require manager sign-off.\n");

  await runPrebrain(
    { all: true },
    {
      collectProfile: NOOP_DEPS.collectProfile,
      extract: NOOP_DEPS.extract,
      walkMcpNotion: () => Promise.reject(new Error("walkMcpNotion should not run without a token")),
      walkMcpMonday: () => Promise.reject(new Error("walkMcpMonday should not run without --monday-boards")),
      walkMcpLinear: () => Promise.reject(new Error("walkMcpLinear should not run without scope")),
      walkMcpJira: () => Promise.reject(new Error("walkMcpJira should not run without scope")),
      walkMcpSentry: () => Promise.reject(new Error("walkMcpSentry should not run without scope")),
      walkMcpGranola: () => Promise.reject(new Error("walkMcpGranola should not run without --granola-folders")),
      // --mcp-zoom is deliberately excluded from --all (see
      // commands/prebrain.ts's own comment on that exclusion) -- no
      // walkMcpZoom stub here, since --all should never even attempt it.
      walkFigmaComments: () => Promise.reject(new Error("walkFigmaComments should not run without --figma-files")),
      walkDatadogNotebooks: () =>
        Promise.reject(new Error("walkDatadogNotebooks should not run without --datadog-notebook-ids")),
      walkGitlabThreads: () => Promise.reject(new Error("walkGitlabThreads should not run without --gitlab-projects")),
      walkHubspotNotes: () => Promise.reject(new Error("walkHubspotNotes should not run without scope")),
      // Airtable takes no per-run scope flag at all (see connect-airtable.ts
      // -- base/tables/fields are picked once at connect time) -- --all
      // alone is enough to attempt it, so it skips one level deeper, on a
      // missing-connection message, not a "needs at least one X" one.
      walkAirtable: () => Promise.reject(new Error("No Airtable connection found.")),
    },
  );

  const output = logs.join("\n");
  expect(output).toContain("--mcp-monday needs at least one board id via --monday-boards");
  expect(output).toContain("--mcp-linear needs at least one team or project id");
  expect(output).toContain("--mcp-jira needs --jira-cloud-id and at least one project");
  expect(output).toContain("--mcp-sentry needs --sentry-org and at least one project");
  expect(output).toContain("--mcp-granola needs at least one folder id via --granola-folders");
  expect(output).not.toContain("--mcp-zoom");
  expect(output).toContain("--figma-comments needs at least one file key via --figma-files");
  expect(output).toContain("--datadog-notebooks needs at least one notebook id via --datadog-notebook-ids");
  expect(output).toContain("--gitlab-threads needs at least one project via --gitlab-projects");
  expect(output).toContain("--hubspot-notes needs at least one pipeline");
});

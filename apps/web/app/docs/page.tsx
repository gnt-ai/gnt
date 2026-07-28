import type { Metadata } from "next";
import { CodeCard } from "@/components/code-card";
import { CollapsibleSection } from "@/components/collapsible-section";
import { DocsTabLink, DocsTabs } from "@/components/docs-tabs";
import { MarketingFooter } from "@/components/marketing-footer";
import { MarketingHeader } from "@/components/marketing-header";
import { TerminalBlock } from "@/components/terminal-block";
import { API_URL } from "@/lib/api-url";

const TITLE = "Documentation · gnt.ai";
const DESCRIPTION = "Connect gnt-brain to any MCP-capable agent. Check an action or query a rule in one call.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { type: "website", title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

// Every org talks to the same API origin — one key (not a subdomain) is
// what scopes a request to your org. Trailing slash: the real deployed
// server 307-redirects a bare /mcp to /mcp/ (see
// apps/api/tests/test_mcp_published_url.py's own doc comment) -- not every
// MCP client is known to follow a redirect on a POST, so every example on
// this page points straight at the final, no-redirect path.
const MCP_URL = `${API_URL}/mcp/`;

const QUICKSTART_LINES = [
  "$ claude mcp add gnt-brain \\",
  `    ${MCP_URL} \\`,
  '    --header "Authorization: Bearer gnt_live_xxxx"',
  "",
  "✓ gnt-brain connected · 5 tools ready",
];

const QUICKSTART_COPY_TEXT = `claude mcp add gnt-brain ${MCP_URL} --header "Authorization: Bearer gnt_live_xxxxxxxxxxxxxxxx"`;

type Tool = {
  name: string;
  signature: string;
  desc: string;
  example: string[];
};

// check_action leads — it's the differentiator: every other tool lets an
// agent look policy up, this one intercepts an action before the agent takes
// it. search_rules/get_rule are the human-approved retrieval surface it's
// built on (status == "approved" only, git-native, PR-merged); the last two
// compile those same rules into downloadable SKILL.md files (what `gnt pull`
// fetches). See README's "Not RAG" framing.
const TOOLS: Tool[] = [
  {
    name: "check_action",
    signature: "check_action(description: str, context: str | None = None) -> dict",
    desc: "Check a described action against your org's approved rules BEFORE the agent takes it. Returns a verdict ('allowed', 'blocked', or 'needs_human') with the governing rule(s) cited and a one-line reason. Conservative by design: no covering rule, a retrieval failure, or an unclear call all return 'needs_human', never a guessed 'allowed' or 'blocked'.",
    example: [
      '$ check_action("refund order #8021, placed 90 days ago")',
      "",
      '{"verdict": "blocked",',
      '  "reason": "Refunds are store-credit only after 30 days",',
      '  "cited_rules": [{"id": "8f2c…", "title": "Refund window"}],',
      '  "rules_retrieved": 3}',
    ],
  },
  {
    name: "search_rules",
    signature: "search_rules(query: str, tags: list[str] | None = None, limit: int = 10) -> list[dict]",
    desc: "Semantic search over this org's approved rules. Only rules with status == 'approved' are ever returned; draft, in-review, rejected, and deprecated rules never reach this tool. Each hit includes a provenance footer (who approved it, when, and its source citations).",
    example: [
      '$ search_rules("refund window", tags=["refunds"])',
      "",
      '[{"id": "8f2c…", "title": "Refund window",',
      '  "body": "Store credit issued for orders 30+ days old",',
      '  "similarity": 0.87,',
      '  "provenance": {"approved_by": "admin_x", "sources": […]}}]',
    ],
  },
  {
    name: "get_rule",
    signature: "get_rule(rule_id: str) -> dict",
    desc: "Fetch a single approved rule by id, scoped to this org. Refuses (returns an error, not another org's data) for cross-tenant ids and for anything not in status == 'approved'.",
    example: [
      '$ get_rule("8f2c1a90-…")',
      "",
      '{"id": "8f2c…", "title": "Refund window",',
      '  "body": "Store credit issued for orders 30+ days old",',
      '  "tags": ["refunds", "policy"], "confidence": 0.92}',
    ],
  },
  {
    name: "list_skill_packs",
    signature: "list_skill_packs() -> list[dict]",
    desc: "List this org's compiled skill packs, newest first, with each one's id, version, and creation time.",
    example: [
      "$ list_skill_packs()",
      "",
      '[{"id": "a91f2c3d-…", "version": 14,',
      '  "created_at": "2026-07-10T09:03:00Z"}]',
    ],
  },
  {
    name: "get_skill_pack",
    signature: "get_skill_pack(pack_id: str) -> dict",
    desc: "Fetch a compiled skill pack's manifest and file list by id -- paths and sha256 hashes, not full file content.",
    example: [
      '$ get_skill_pack("a91f2c3d-…")',
      "",
      '{"id": "a91f2c3d-…", "version": 14, "manifest": {…},',
      '  "files": [{"path": "skills/rules/refunds/SKILL.md", "sha256": "…"}]}',
    ],
  },
];

const MCP_CLIENT_LINES = [
  "from mcp import ClientSession",
  "from mcp.client.streamable_http import streamablehttp_client",
  "",
  `URL = "${MCP_URL}"`,
  'TOKEN = "gnt_live_xxxx"',
  "",
  "async with streamablehttp_client(",
  '    URL, headers={"Authorization": f"Bearer {TOKEN}"}',
  ") as (read, write, _):",
  "    async with ClientSession(read, write) as session:",
  "        await session.initialize()",
  '        result = await session.call_tool(',
  '            "search_rules", {"query": "refund window"}',
  "        )",
];

const MCP_CLIENT_COPY_TEXT = MCP_CLIENT_LINES.join("\n");

const OPENAI_AGENT_LINES = [
  "from openai import OpenAI",
  "",
  'client = OpenAI()',
  "resp = client.responses.create(",
  '    model="gpt-4.1",',
  '    input="What is our refund policy?",',
  "    tools=[{",
  '        "type": "mcp",',
  '        "server_label": "gnt-brain",',
  `        "server_url": "${MCP_URL}",`,
  '        "headers": {"Authorization": "Bearer gnt_live_xxxx"},',
  "    }],",
  ")",
];

const OPENAI_AGENT_COPY_TEXT = OPENAI_AGENT_LINES.join("\n");

// MCP_URL above is already the canonical, no-redirect form. The key is a
// config-referenced env var, not a literal token, matching OpenClaw's own
// guidance against inlining secrets in openclaw.json.
const OPENCLAW_CONFIG_LINES = [
  "{",
  '  "mcp": {',
  '    "servers": {',
  '      "gnt-brain": {',
  `        "url": "${MCP_URL}",`,
  '        "transport": "streamable-http",',
  '        "headers": { "Authorization": "Bearer ${GNT_MCP_KEY}" }',
  "      }",
  "    }",
  "  }",
  "}",
];

const OPENCLAW_CONFIG_COPY_TEXT = OPENCLAW_CONFIG_LINES.join("\n");

const HOOK_LINES = [
  "# .claude/hooks/gnt_check.py: a PreToolUse hook that asks gnt before",
  "# any world-changing tool call runs. Wire it in .claude/settings.json.",
  "import asyncio, json, sys",
  "from mcp import ClientSession",
  "from mcp.client.streamable_http import streamablehttp_client",
  "",
  `URL = "${MCP_URL}"`,
  'TOKEN = "gnt_live_xxxx"',
  "# Only gate tools that actually change the world; let reads through.",
  'GUARDED = {"Bash", "Write", "Edit", "WebFetch"}',
  "",
  "async def check(description):",
  "    async with streamablehttp_client(",
  '        URL, headers={"Authorization": f"Bearer {TOKEN}"}',
  "    ) as (read, write, _):",
  "        async with ClientSession(read, write) as session:",
  "            await session.initialize()",
  '            res = await session.call_tool(',
  '                "check_action", {"description": description}',
  "            )",
  "            return json.loads(res.content[0].text)",
  "",
  "event = json.load(sys.stdin)",
  'if event["tool_name"] not in GUARDED:',
  "    sys.exit(0)  # not side-effectful; let it through",
  "",
  'verdict = asyncio.run(check(json.dumps(event["tool_input"])))',
  'if verdict["verdict"] == "blocked":',
  '    print(json.dumps({"decision": "block", "reason": verdict["reason"]}))',
  'elif verdict["verdict"] == "needs_human":',
  '    print(json.dumps({"decision": "block",',
  '        "reason": "Escalate to a human: " + verdict["reason"]}))',
  '# "allowed" → exit 0 with no output, and the tool call proceeds.',
];

const HOOK_COPY_TEXT = HOOK_LINES.join("\n");

const SYSTEM_PROMPT_LINES = [
  "Before any action that sends a message, moves money, deletes data, or is",
  "otherwise hard to undo, first call the check_action tool with a plain-",
  "English description of what you are about to do.",
  "",
  '- verdict "allowed": proceed.',
  '- verdict "blocked": do not proceed. Tell the user why, citing the rule.',
  '- verdict "needs_human": stop and ask a human to approve before acting.',
  "",
  "Never treat a missing or unclear verdict as permission to act.",
];

const SYSTEM_PROMPT_COPY_TEXT = SYSTEM_PROMPT_LINES.join("\n");

const WEBHOOK_CREATE_LINES = [
  '$ gnt webhook create "monday zap"',
  "",
  `Ingest URL: ${API_URL}/v1/webhooks/ingest/whk_xxxx`,
  "",
  "# This is shown once, copy it now.",
];

const WEBHOOK_CREATE_COPY_TEXT = 'gnt webhook create "monday zap"';

const WEBHOOK_CURL_LINES = [
  '$ curl -X POST "$INGEST_URL" \\',
  '    -H "Content-Type: application/json" \\',
  "    -d '{",
  '      "title": "Refund window",',
  '      "body": "Refunds within 30 days get a full refund; after that, store credit only.",',
  '      "source": "monday.com item comment"',
  "    }'",
  "",
  '{"id": "8f2c…", "status": "draft"}',
];

const WEBHOOK_CURL_COPY_TEXT = WEBHOOK_CURL_LINES.join("\n");

// Gmail export walker (connector sprint T3.4): the interim Gmail path --
// gnt prebrain --gmail reads a Google Takeout mail export (.mbox), no
// Google OAuth approval needed. The real Gmail OAuth connector replaces
// this once it clears Google's own app-review process.
const GMAIL_COMMAND_LINES = [
  "$ gnt prebrain --gmail ~/Takeout/Mail/All\\ mail\\ Including\\ Spam\\ and\\ Trash.mbox \\",
  "    --gmail-since 2026-01-01 \\",
  "    --gmail-from acme.com",
  "",
  "Found 214 candidate chunks:",
  "  Gmail export: 214 chunks across 38 files",
];

const GMAIL_COMMAND_COPY_TEXT =
  "gnt prebrain --gmail ~/Takeout/Mail/All\\ mail\\ Including\\ Spam\\ and\\ Trash.mbox --gmail-since 2026-01-01 --gmail-from acme.com";

// Outlook export walker (connector sprint T3.5): same interim-local-path
// framing as the Gmail export walker above -- gnt prebrain --outlook
// reads a directory of .eml files (or a single mbox-shaped file), no
// Microsoft Graph API approval needed. PST is explicitly out of scope;
// see this tab's own copy for what Outlook's export flow actually
// supports.
const OUTLOOK_COMMAND_LINES = [
  "$ gnt prebrain --outlook ~/Exports/outlook-eml \\",
  "    --outlook-since 2026-01-01 \\",
  "    --outlook-from acme.com",
  "",
  "Found 96 candidate chunks:",
  "  Outlook export: 96 chunks across 19 files",
];

const OUTLOOK_COMMAND_COPY_TEXT =
  "gnt prebrain --outlook ~/Exports/outlook-eml --outlook-since 2026-01-01 --outlook-from acme.com";

// Meeting-notes export walker (connector sprint T3.3): gnt prebrain
// --meeting-notes reads Otter/Fireflies/Fathom transcript exports -- VTT/
// SRT cue files and plain-text transcripts, auto-detected per file -- no
// per-vendor approval or connection needed, same interim-local-path shape
// as --gmail/--outlook above.
const MEETING_NOTES_COMMAND_LINES = [
  "$ gnt prebrain --meeting-notes ~/Exports/meeting-transcripts",
  "",
  "Found 58 candidate chunks:",
  "  Meeting notes export: 58 chunks across 14 files",
];

const MEETING_NOTES_COMMAND_COPY_TEXT = "gnt prebrain --meeting-notes ~/Exports/meeting-transcripts";

// Hermes Agent (connector sprint T6.2, Nous Research's agent harness,
// github.com/NousResearch/hermes-agent): the serving-side half of T6 --
// making an agent harness call gnt's MCP endpoint and actually use
// check_action, not just have it available. Config schema and skill
// format verified live against Hermes's own docs
// (hermes-agent.nousresearch.com/docs) at build time, not assumed from
// another harness's shape: config lives at ~/.hermes/config.yaml under a
// top-level mcp_servers key, HTTP servers take url/headers/tools.include,
// and skills are SKILL.md files under ~/.hermes/skills/<category>/<name>/.
// The key is a config-referenced env var, not a literal token -- Hermes
// resolves ${VAR_NAME} references inside config.yaml string values
// against the environment (falling back to ~/.hermes/.env), confirmed
// against Hermes's own configuration.md and cli-config.yaml.example.
// Same GNT_MCP_KEY name the OpenClaw connector already uses, so a
// customer running both harnesses manages one variable.
const HERMES_CONNECT_LINES = ["$ gnt connect hermes", "", "✓ Connected. gnt's MCP tools are now available to Hermes."];

const HERMES_CONNECT_COPY_TEXT = "gnt connect hermes";

const HERMES_CONFIG_LINES = [
  "mcp_servers:",
  "  gnt:",
  `    url: "${MCP_URL}"`,
  "    headers:",
  '      Authorization: "Bearer ${GNT_MCP_KEY}"',
  "    tools:",
  "      include: [check_action, search_rules, get_rule, list_skill_packs, get_skill_pack]",
  "      resources: false",
  "      prompts: false",
];

const HERMES_CONFIG_COPY_TEXT = HERMES_CONFIG_LINES.join("\n");

const HERMES_SKILL_INSTALL_LINES = ["$ hermes skills install https://gntai.dev/skills/hermes/SKILL.md"];

const HERMES_SKILL_INSTALL_COPY_TEXT = HERMES_SKILL_INSTALL_LINES.join("\n");

// Granola MCP connector (connector sprint T2.1): gnt connect granola-mcp
// then gnt prebrain --mcp-granola --granola-folders <id> reads meeting
// notes and transcripts from customer-chosen Granola folders, locally.
const GRANOLA_CONNECT_LINES = ["$ gnt connect granola-mcp", "", "✓ Saved. Run `gnt prebrain --mcp-granola …` to read from it."];

const GRANOLA_CONNECT_COPY_TEXT = "gnt connect granola-mcp";

const GRANOLA_COMMAND_LINES = [
  "$ gnt prebrain --mcp-granola --granola-folders team-standups,eng-planning",
  "",
  "Found 46 candidate chunks:",
  "  Granola (live MCP): 46 chunks across 12 files",
];

const GRANOLA_COMMAND_COPY_TEXT = "gnt prebrain --mcp-granola --granola-folders team-standups,eng-planning";

// Figma comments walker (connector sprint T2.7 v2): gnt prebrain
// --figma-comments reads comment threads on customer-chosen Figma files
// direct against Figma's own REST API -- no MCP server, no third-party
// package, no gnt server ever in the read path.
const FIGMA_COMMAND_LINES = [
  "$ gnt connect figma",
  "$ gnt prebrain --figma-comments --figma-files abc123,def456",
  "",
  "Found 12 candidate chunks:",
  "  Figma comments: 12 chunks across 9 files",
];

const FIGMA_COMMAND_COPY_TEXT = "gnt connect figma\ngnt prebrain --figma-comments --figma-files abc123,def456";

// Datadog notebooks walker (connector sprint T2.6): gnt prebrain
// --datadog-notebooks reads notebook titles and markdown content direct
// against Datadog's own REST API -- no MCP server, no gnt server ever in
// the read path. Notebooks are also where Datadog's own incident
// postmortems live, so this is the same read path for both.
const DATADOG_COMMAND_LINES = [
  "$ gnt connect datadog",
  "$ gnt prebrain --datadog-notebooks --datadog-notebook-ids 4821,5093",
  "",
  "Found 8 candidate chunks:",
  "  Datadog notebooks: 8 chunks across 2 files",
];

const DATADOG_COMMAND_COPY_TEXT = "gnt connect datadog\ngnt prebrain --datadog-notebooks --datadog-notebook-ids 4821,5093";

// GitLab threads walker (connector sprint T4.1): gnt prebrain
// --gitlab-threads reads merge request and issue discussion threads on
// customer-chosen GitLab projects direct against GitLab's own REST API --
// no MCP server, no gnt server ever in the read path.
const GITLAB_COMMAND_LINES = [
  "$ gnt connect gitlab-threads",
  "$ gnt prebrain --gitlab-threads --gitlab-projects acme/widgets,42",
  "",
  "Found 14 candidate chunks:",
  "  GitLab threads: 14 chunks across 9 files",
];

const GITLAB_COMMAND_COPY_TEXT = "gnt connect gitlab-threads\ngnt prebrain --gitlab-threads --gitlab-projects acme/widgets,42";

// HubSpot notes walker (connector sprint T2.8): gnt prebrain --hubspot-notes
// reads note text direct against HubSpot's own REST CRM API -- no MCP
// server, no gnt server ever in the read path. Scoped to deal pipelines
// and/or teams; never reads a contact, company, or deal record field.
const HUBSPOT_COMMAND_LINES = [
  "$ gnt connect hubspot",
  "$ gnt prebrain --hubspot-notes --hubspot-pipelines 12345 --hubspot-teams 67890",
  "",
  "Found 14 candidate chunks:",
  "  HubSpot notes: 14 chunks across 9 files",
];

const HUBSPOT_COMMAND_COPY_TEXT =
  "gnt connect hubspot\ngnt prebrain --hubspot-notes --hubspot-pipelines 12345 --hubspot-teams 67890";

// Airtable connector (connector sprint T4.4): gnt prebrain --airtable
// reads direct from Airtable's own REST API -- no MCP server, no gnt
// server ever in the read path. Unlike every other connector on this page,
// it takes no scope flags: which base, which tables, and which fields are
// safe prose are all picked once, interactively, in `gnt connect airtable`
// itself, against that base's real live schema.
const AIRTABLE_COMMAND_LINES = [
  "$ gnt connect airtable",
  "$ gnt prebrain --airtable",
  "",
  "Found 19 candidate chunks:",
  "  Airtable: 19 chunks across 2 files",
];

const AIRTABLE_COMMAND_COPY_TEXT = "gnt connect airtable\ngnt prebrain --airtable";

// Zoom MCP connector (connector sprint T2.2): gnt connect zoom-mcp then gnt
// prebrain --mcp-zoom --zoom-hosts <id> reads recording transcripts from
// customer-chosen Zoom hosts, scoped to a date range, locally.
const ZOOM_CONNECT_LINES = ["$ gnt connect zoom-mcp", "", "✓ Saved. Run `gnt prebrain --mcp-zoom …` to read from it."];

const ZOOM_CONNECT_COPY_TEXT = "gnt connect zoom-mcp";

const ZOOM_COMMAND_LINES = [
  "$ gnt prebrain --mcp-zoom --zoom-hosts host@acme.com \\",
  "    --zoom-from 2026-07-01 --zoom-to 2026-07-15",
  "",
  "Found 18 candidate chunks:",
  "  Zoom (live MCP): 18 chunks across 6 files",
];

const ZOOM_COMMAND_COPY_TEXT = "gnt prebrain --mcp-zoom --zoom-hosts host@acme.com --zoom-from 2026-07-01 --zoom-to 2026-07-15";

// Generic MCP-client harness guide (connector sprint T6.3). Everything
// above this point is ingestion -- reading content into gnt. This is the
// other direction's generic case: wiring an arbitrary MCP-capable client
// to call out to gnt's own endpoint. OpenClaw and Hermes each get a
// deeper, harness-specific guide with a distributable skill of their own;
// this tab is what covers every other client with the same endpoint, key,
// and check_action discipline those two teach.
const GENERIC_MCP_CONFIG_LINES = [
  "{",
  '  "mcpServers": {',
  '    "gnt-brain": {',
  `      "url": "${MCP_URL}",`,
  '      "headers": {',
  '        "Authorization": "Bearer gnt_live_xxxx"',
  "      }",
  "    }",
  "  }",
  "}",
];

const GENERIC_MCP_CONFIG_COPY_TEXT = GENERIC_MCP_CONFIG_LINES.join("\n");

const GENERIC_KEYS_CREATE_LINES = [
  "$ gnt keys create",
  "",
  `MCP URL: ${MCP_URL}`,
  "Key:     gnt_live_xxxxxxxxxxxxxxxx",
  "",
  "# Shown once -- copy it now.",
];

const GENERIC_KEYS_CREATE_COPY_TEXT = "gnt keys create";

// Same check_action-first discipline as the Enforce tab's system-prompt
// block above, reused verbatim (spread, not retyped) plus the two things a
// standing bootstrap prompt needs that a single-action instruction doesn't:
// how to pull company context beyond one action, and that only human-
// approved rules ever come back from either retrieval tool.
const BOOTSTRAP_PROMPT_LINES = [
  ...SYSTEM_PROMPT_LINES,
  "",
  "For company-specific context beyond a single action -- answering a",
  "question about policy, or working from a standing set of rules instead",
  "of one check -- call search_rules with a plain-English query, or pull a",
  "compiled skill pack with list_skill_packs / get_skill_pack. Only rules a",
  "human has approved are ever returned.",
];

const BOOTSTRAP_PROMPT_COPY_TEXT = BOOTSTRAP_PROMPT_LINES.join("\n");

export default function DocsPage() {
  return (
    <div className="flex-1 flex flex-col">
      <MarketingHeader />

      <DocsTabs
        tabs={[
          {
            id: "quickstart",
            label: "Quickstart",
            content: (
              <div className="flex flex-col gap-4">
                <h1 className="font-mono text-2xl font-bold tracking-tight">Quickstart</h1>
                <p className="text-sm text-muted leading-relaxed">
                  New org? Run <code className="font-mono">gnt prebrain</code>{" "} first, it scans this
                  repo and drafts your first rules automatically -- add <code className="font-mono">--docs</code>{" "}
                  or <code className="font-mono">--notion</code>{" "} to also pull from a docs folder or a
                  Notion export. This page covers the other half: connecting an agent once approved
                  rules exist.
                </p>
                <p className="text-sm text-muted leading-relaxed">
                  One MCP endpoint, {TOOLS.length}{" "}tools. Connect any MCP-capable agent and it can
                  check an action against your rules before taking it, search your org&apos;s approved
                  rules, fetch one by id, and pull the compiled skill pack. Nothing an agent sees
                  hasn&apos;t already been merged as a pull request by a human.
                </p>
                <TerminalBlock lines={QUICKSTART_LINES} copyText={QUICKSTART_COPY_TEXT} />
                <p className="text-sm text-muted leading-relaxed">
                  Get your key and endpoint with <code className="font-mono">gnt keys create</code>,
                  then run the command above from any MCP-capable client. Claude Code, Claude Desktop,
                  or your own agent over the streamable HTTP transport all work the same way.
                </p>
                <p className="text-sm text-muted leading-relaxed">
                  That merge is the whole approval step, and it works the same way no matter where a
                  rule came from. <code className="font-mono">gnt prebrain</code>{" "}
                  opens its own pull requests directly; anything else, a webhook, Slack&apos;s{" "}
                  <code className="font-mono">/brain</code>, a rule typed by hand, goes through{" "}
                  <code className="font-mono">gnt review</code>, which renders it to markdown, opens
                  the PR, and flags anything that looks like a duplicate or contradiction of an
                  existing rule right in the PR body. A human reviews the diff like any other code
                  change, and merging it is the approval: that same merge recompiles the org&apos;s
                  skill pack and makes the rule searchable. Nothing reaches an agent that hasn&apos;t
                  gone through a real, merged PR.
                </p>
                <p className="text-sm text-muted leading-relaxed">
                  <code className="font-mono">gnt connect github</code>{" "} connects that repo through a
                  real GitHub App, not a pasted personal access token. It asks for exactly three
                  permissions: <strong>Contents (read/write)</strong>, to read a rule file&apos;s
                  current content and write the branch a proposal opens on;{" "}
                  <strong>Pull requests (read/write)</strong>, to open, read, and close the PRs that
                  carry every proposal and every approval; and{" "}
                  <strong>Metadata (read-only)</strong>, GitHub&apos;s own forced minimum for any
                  App, no App can ask for less. No org, issues, actions, or admin scope of any kind.
                  Installation is scoped to the one repo you pick during install, not your whole
                  account, and every token gnt uses against it is minted per request and expires
                  within the hour, nothing long-lived sits in gnt&apos;s database the way a PAT used
                  to. The webhook that confirms a merge is managed by the App itself, not something
                  you register by hand. <code className="font-mono">gnt connect github --pat</code>{" "}
                  still works if you&apos;d rather paste a fine-grained token instead; an org already
                  on that flow runs <code className="font-mono">gnt connect github --upgrade</code>{" "}
                  to move over.
                </p>
                <p className="text-sm text-muted leading-relaxed">
                  gnt is source-available (FSL-1.1-Apache-2.0, converts to Apache-2.0 two years
                  after launch) -- everything above also runs as a self-hosted{" "}
                  <code className="font-mono">docker compose up</code> on your own infrastructure,
                  with your own keys, instead of the hosted service. See{" "}
                  <a
                    href="https://github.com/gnt-ai/gnt/blob/main/docs/self-hosting/README.md"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4 decoration-border hover:text-foreground transition-colors"
                  >
                    docs/self-hosting/README.md
                  </a>{" "}
                  in the repo for the full walkthrough.
                </p>
              </div>
            ),
          },
          {
            id: "tools",
            label: "Tools",
            content: (
              <div className="flex flex-col gap-8">
                <h1 className="font-mono text-2xl font-bold tracking-tight">Tools reference</h1>
                {TOOLS.map((tool) => (
                  <div key={tool.name} className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1">
                      <code className="font-mono text-sm text-foreground">{tool.signature}</code>
                      <p className="text-sm text-muted leading-relaxed">{tool.desc}</p>
                    </div>
                    <TerminalBlock lines={tool.example} copyText={tool.example.join("\n")} />
                  </div>
                ))}
              </div>
            ),
          },
          {
            id: "enforce",
            label: "Enforce",
            content: (
              <div className="flex flex-col gap-8">
                <h1 className="font-mono text-2xl font-bold tracking-tight">Enforce before acting</h1>
                <p className="text-sm text-muted leading-relaxed">
                  Retrieval tells an agent what the policy is; <code className="font-mono">check_action</code>{" "}
                  stops it from breaking it. Call it right before a side-effectful step and branch on the
                  verdict: proceed on <code className="font-mono">allowed</code>, stop and cite the rule on{" "}
                  <code className="font-mono">blocked</code>, escalate on <code className="font-mono">needs_human</code>.
                  There are two natural places to wire it in.
                </p>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Claude Code PreToolUse hook</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    A <code className="font-mono">PreToolUse</code>{" "} hook runs before every tool call. This one
                    checks the guarded, world-changing tools against your rules and blocks the call on{" "}
                    <code className="font-mono">blocked</code>{" "} or <code className="font-mono">needs_human</code>,
                    so enforcement doesn&apos;t depend on the model choosing to ask.
                  </p>
                  <CodeCard lines={HOOK_LINES} copyText={HOOK_COPY_TEXT} language="python" />
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">System prompt instruction</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    For agents without a hook layer, add a standing policy-check instruction to the system
                    prompt. Pair it with the hook above for defense in depth: the prompt guides the model,
                    the hook enforces regardless.
                  </p>
                  <CodeCard lines={SYSTEM_PROMPT_LINES} copyText={SYSTEM_PROMPT_COPY_TEXT} language="text" />
                </div>
              </div>
            ),
          },
          {
            id: "connect",
            label: "Connect",
            content: (
              <div className="flex flex-col gap-8">
                <h1 className="font-mono text-2xl font-bold tracking-tight">Connect</h1>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">claude.ai connectors</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    In claude.ai, go to Settings &rarr; Connectors &rarr; Add custom connector. Paste
                    your MCP endpoint (from <code className="font-mono">gnt keys create</code>) as the
                    server URL, then add an{" "}
                    <code className="font-mono">Authorization: Bearer gnt_live_xxxx</code>{" "} header with
                    your key. All {TOOLS.length}{" "}tools become available in any chat once it&apos;s
                    connected.
                  </p>
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Claude Code</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Covered by the quickstart above.{" "}
                    <DocsTabLink id="quickstart">Jump back up</DocsTabLink>.
                  </p>
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Raw MCP client (Python)</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Talk to the endpoint directly over streamable HTTP with the official MCP SDK.
                  </p>
                  <CodeCard lines={MCP_CLIENT_LINES} copyText={MCP_CLIENT_COPY_TEXT} language="python" />
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">OpenAI-compatible agent</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    The Responses API supports remote MCP servers as a tool type. Point it at
                    the same endpoint and header.
                  </p>
                  <CodeCard lines={OPENAI_AGENT_LINES} copyText={OPENAI_AGENT_COPY_TEXT} language="python" />
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">OpenClaw</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Run <code className="font-mono">gnt connect openclaw</code>{" "} to detect a local
                    install and write this for you, or add it to{" "}
                    <code className="font-mono">~/.openclaw/openclaw.json</code>{" "} by hand and export{" "}
                    <code className="font-mono">GNT_MCP_KEY</code>{" "} before starting the gateway.
                    Connecting only makes the tools available, so pair it with the{" "}
                    <DocsTabLink id="enforce">check_action skill</DocsTabLink>{" "} below: that&apos;s
                    what gets OpenClaw to actually call it before acting, not just have it on hand.
                  </p>
                  <CodeCard lines={OPENCLAW_CONFIG_LINES} copyText={OPENCLAW_CONFIG_COPY_TEXT} language="json" />
                </div>
              </div>
            ),
          },
          {
            id: "mcp-clients",
            label: "Other clients",
            content: (
              <div className="flex flex-col gap-8">
                <h1 className="font-mono text-2xl font-bold tracking-tight">Other MCP clients</h1>
                <p className="text-sm text-muted leading-relaxed">
                  The <DocsTabLink id="connect">Connect</DocsTabLink>{" "} tab covers claude.ai and
                  Claude Code specifically, and OpenClaw and Hermes each get their own deeper,
                  harness-specific guide with a distributable skill baked in. This tab is the
                  generic version underneath all of those: point Cursor, or anything else that
                  speaks MCP, at the same endpoint with the same key, and it gets the same{" "}
                  {TOOLS.length}{" "}tools and the same check_action discipline.
                </p>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Point it at the endpoint</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Most MCP-capable clients take a remote server as a URL plus headers, either in
                    a config file directly or a settings UI that writes one for you. The shape
                    below is what a remote HTTP server entry looks like; if your client&apos;s
                    config uses different key names, the three fields it&apos;s asking for are
                    always the same: a name for the server, this URL, and the bearer header.
                  </p>
                  <CodeCard lines={GENERIC_MCP_CONFIG_LINES} copyText={GENERIC_MCP_CONFIG_COPY_TEXT} language="json" />
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Get a key</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    <code className="font-mono">gnt keys create</code>{" "} mints an org-scoped MCP key
                    and prints the endpoint alongside it. The key is shown once, so paste both
                    straight into the config above.
                  </p>
                  <TerminalBlock lines={GENERIC_KEYS_CREATE_LINES} copyText={GENERIC_KEYS_CREATE_COPY_TEXT} />
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Teach it the check_action discipline</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Connecting the endpoint only makes the {TOOLS.length}{" "}tools available.
                    Nothing makes a harness actually call{" "}
                    <code className="font-mono">check_action</code>{" "} before it acts. Paste this
                    into the client&apos;s system prompt or custom instructions field.
                  </p>
                  <CodeCard lines={BOOTSTRAP_PROMPT_LINES} copyText={BOOTSTRAP_PROMPT_COPY_TEXT} language="text" />
                  <p className="text-sm text-muted leading-relaxed">
                    If your client supports a hook layer, something that runs before a tool call
                    regardless of what the model decides, the way a{" "}
                    <code className="font-mono">PreToolUse</code>{" "} hook does, pair this prompt
                    with that hook pattern on the <DocsTabLink id="enforce">Enforce</DocsTabLink>{" "}
                    tab for defense in depth: the prompt guides the model, the hook enforces
                    regardless.
                  </p>
                </div>
              </div>
            ),
          },
          {
            id: "hermes-agent",
            label: "Hermes Agent",
            content: (
              <div className="flex flex-col gap-8">
                <h1 className="font-mono text-2xl font-bold tracking-tight">Hermes Agent</h1>
                <p className="text-sm text-muted leading-relaxed">
                  Nous Research&apos;s{" "}
                  <span className="text-foreground">Hermes Agent</span>{" "} reads MCP servers straight
                  out of its own config file. Connecting it to gnt makes the {TOOLS.length} tools
                  above available the same way they are anywhere else. The part that
                  actually matters is getting Hermes to call{" "}
                  <code className="font-mono">check_action</code>{" "} before it acts, which the skill
                  below does.
                </p>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Connect it</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    <code className="font-mono">gnt connect hermes</code>{" "} looks for a local Hermes
                    install (<code className="font-mono">~/.hermes</code>), shows you the exact
                    block it wants to add to <code className="font-mono">~/.hermes/config.yaml</code>,
                    and writes nothing until you say yes. Once you confirm, it mints a fresh MCP
                    key and prints it once for you to export. The key itself never touches
                    the config file, only a <code className="font-mono">${"{GNT_MCP_KEY}"}</code>{" "}
                    reference does.
                  </p>
                  <TerminalBlock lines={HERMES_CONNECT_LINES} copyText={HERMES_CONNECT_COPY_TEXT} />
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Or add it by hand</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Hermes reads MCP servers from a top-level{" "}
                    <code className="font-mono">mcp_servers</code>{" "} key in{" "}
                    <code className="font-mono">~/.hermes/config.yaml</code>. Paste the block below
                    as-is, including the <code className="font-mono">${"{GNT_MCP_KEY}"}</code>{" "}
                    reference. Don&apos;t inline a real key there. Get one from{" "}
                    <code className="font-mono">gnt keys create</code>, then{" "}
                    <code className="font-mono">export GNT_MCP_KEY=&lt;that key&gt;</code>{" "} in your
                    shell (or add it to <code className="font-mono">~/.hermes/.env</code>, Hermes&apos;s
                    own place for secrets) before starting Hermes, or{" "}
                    <code className="font-mono">/reload-mcp</code>{" "} in a running session.
                  </p>
                  <CodeCard lines={HERMES_CONFIG_LINES} copyText={HERMES_CONFIG_COPY_TEXT} language="yaml" />
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Install the skill</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Connecting the MCP server only makes the tools available. Nothing makes
                    Hermes call them before acting on its own. The{" "}
                    <code className="font-mono">gnt-check-action</code>{" "} skill closes that gap: it
                    tells Hermes exactly when and how to call{" "}
                    <code className="font-mono">check_action</code>, in Hermes&apos;s own SKILL.md
                    format, installable straight from a URL, no repo clone required.
                  </p>
                  <TerminalBlock lines={HERMES_SKILL_INSTALL_LINES} copyText={HERMES_SKILL_INSTALL_COPY_TEXT} />
                  <p className="text-sm text-muted leading-relaxed">
                    Same instruction as the{" "}
                    <DocsTabLink id="enforce">Enforce</DocsTabLink>{" "} tab&apos;s system prompt block,
                    every surface teaches it the same way:
                  </p>
                  <CodeCard lines={SYSTEM_PROMPT_LINES} copyText={SYSTEM_PROMPT_COPY_TEXT} language="text" />
                  <p className="text-sm text-muted leading-relaxed">
                    For a standing instruction Hermes reads on every session in a given project
                    rather than one it has to decide to load, drop the same instruction in that
                    project&apos;s own <code className="font-mono">HERMES.md</code> (or{" "}
                    <code className="font-mono">AGENTS.md</code>, which Hermes also reads) instead.
                    See{" "}
                    <a
                      href="/skills/hermes/HERMES.md"
                      className="underline underline-offset-4 decoration-border hover:text-foreground transition-colors"
                    >
                      /skills/hermes/HERMES.md
                    </a>{" "}
                    for a ready-made one.
                  </p>
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">What Hermes calls these tools</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Hermes registers MCP tools as <code className="font-mono">mcp_&lt;server&gt;_&lt;tool&gt;</code>
                    . With the server named <code className="font-mono">gnt</code> (as above),
                    that&apos;s <code className="font-mono">mcp_gnt_check_action</code>,{" "}
                    <code className="font-mono">mcp_gnt_search_rules</code>,{" "}
                    <code className="font-mono">mcp_gnt_get_rule</code>,{" "}
                    <code className="font-mono">mcp_gnt_list_skill_packs</code>, and{" "}
                    <code className="font-mono">mcp_gnt_get_skill_pack</code>. The skill
                    above already accounts for the prefix.
                  </p>
                </div>
              </div>
            ),
          },
          {
            id: "webhooks",
            label: "Webhooks & more sources",
            content: (
              <div className="flex flex-col gap-8">
                <h1 className="font-mono text-2xl font-bold tracking-tight">Webhooks & more sources</h1>
                <p className="text-sm text-muted leading-relaxed">
                  Everything above connects an agent <em>out</em>{" "} to your rules. This is the other
                  direction: pulling decision-prose <em>in</em>{" "} from tools your team already uses,
                  a monday.com item comment, a HubSpot engagement note, a ticket thread, without
                  anyone hand-typing it. Each ingested item lands as a draft rule, exactly like{" "}
                  <code className="font-mono">POST /v1/rules</code>{" "} would, ready for someone to
                  review and submit through the normal <code className="font-mono">gnt review</code>{" "}
                  flow. Nothing here skips human approval, it only skips the copy-paste.
                </p>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Create an ingest URL</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Each token is its own credential, scoped to this org, and can only ever create
                    draft rules, nothing else an MCP key can do.
                  </p>
                  <TerminalBlock lines={WEBHOOK_CREATE_LINES} copyText={WEBHOOK_CREATE_COPY_TEXT} />
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">From your tool&apos;s outbound webhook settings</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Any tool or system that can send an HTTP POST can feed gnt, monday.com, HubSpot,
                    or whatever else holds your comment/note stream. Point its outbound webhook
                    action at the ingest URL from <code className="font-mono">gnt webhook create</code>,
                    set the payload type to JSON, and map fields:
                  </p>
                  <ol className="flex flex-col gap-2 text-sm text-muted leading-relaxed list-decimal pl-5">
                    <li>
                      <code className="font-mono">body</code>{" "} to the comment/note text.
                    </li>
                    <li>
                      <code className="font-mono">title</code>{" "} to whatever short label the source
                      gives you (an item name, a subject line); trim it down if the field is long
                      free text.
                    </li>
                    <li>
                      <code className="font-mono">source</code>{" "} is optional but worth mapping too
                      (a permalink back to the item/note); it shows up on the pull request so
                      whoever reviews it can check the rule against where it came from.
                    </li>
                  </ol>
                  <p className="text-sm text-muted leading-relaxed">
                    Turn it on. Every new comment/note becomes a draft rule.
                  </p>
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Raw webhook (anything else)</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Prefer to skip the middleman? Any tool that can send a JSON POST works the same
                    way. The token is embedded in the URL itself, no custom headers required.
                  </p>
                  <TerminalBlock lines={WEBHOOK_CURL_LINES} copyText={WEBHOOK_CURL_COPY_TEXT} />
                </div>

                <CollapsibleSection
                  items={[
                    {
                      label: "Other ways rules get in",
                      content: (
                        <>
                          <p className="text-sm text-muted leading-relaxed">
                            Webhooks aren&apos;t the only ambient source. <code className="font-mono">gnt connect
                            slack</code>{" "} connects a workspace, then anyone can type{" "}
                            <code className="font-mono">/brain</code>{" "} plus a message in Slack to draft a
                            rule the same way, that content and this webhook path both reach gnt&apos;s
                            server directly and get masked there on arrival, permanently, since neither has
                            a customer device in the loop.
                          </p>
                          <p className="text-sm text-muted leading-relaxed">
                            <code className="font-mono">gnt connect notion-mcp</code>,{" "}
                            <code className="font-mono">gnt connect monday-mcp</code>,{" "}
                            <code className="font-mono">gnt connect linear-mcp</code>,{" "}
                            <code className="font-mono">gnt connect jira-mcp</code>,{" "}
                            <code className="font-mono">gnt connect sentry-mcp</code>,{" "}
                            <code className="font-mono">gnt connect granola-mcp</code>, and{" "}
                            <code className="font-mono">gnt connect zoom-mcp</code>{" "} are different:{" "}
                            <code className="font-mono">gnt prebrain --mcp-notion</code>,{" "}
                            <code className="font-mono">--mcp-monday</code>,{" "}
                            <code className="font-mono">--mcp-linear</code>,{" "}
                            <code className="font-mono">--mcp-jira</code>,{" "}
                            <code className="font-mono">--mcp-sentry</code>,{" "}
                            <code className="font-mono">--mcp-granola</code>, or{" "}
                            <code className="font-mono">--mcp-zoom</code>{" "} pulls read-only content straight
                            from those tools&apos; own official MCP servers, but the pull happens locally,
                            from your device, through the same CLI-side privacy gate every other prebrain
                            walker uses. Connected several of these already?{" "}
                            <code className="font-mono">gnt prebrain --all</code>{" "} turns every connector
                            below on at once instead of listing each flag by name. It only enables a
                            connector; it doesn&apos;t invent scope, so one that needs its own scope flag
                            (<code className="font-mono">--linear-teams</code>,{" "}
                            <code className="font-mono">--gitlab-projects</code>, and so on) still skips
                            with its usual message unless that flag comes along with it.
                          </p>
                          <p className="text-sm text-muted leading-relaxed">
                            Linear&apos;s adapter reads issue descriptions, comments, and
                            project documents within the teams and projects you scope it to (
                            <code className="font-mono">--linear-teams</code> /{" "}
                            <code className="font-mono">--linear-projects</code>). It never reads
                            workspace-wide, and it never touches assignee, priority, or any other issue
                            metadata, only the prose. See the{" "}
                            <DocsTabLink id="granola-mcp">Granola</DocsTabLink>{" "} and{" "}
                            <DocsTabLink id="zoom-mcp">Zoom</DocsTabLink>{" "} tabs for the two meeting-transcript
                            connectors specifically. <code className="font-mono">gnt prebrain --gmail</code>{" "}
                            is the same local-first shape again, reading a Gmail export instead of a live
                            connection, and so is <code className="font-mono">gnt prebrain --outlook</code>{" "}
                            for an Outlook export, and{" "}
                            <code className="font-mono">gnt prebrain --meeting-notes</code>{" "} for an Otter,
                            Fireflies, or Fathom transcript export. See the{" "}
                            <DocsTabLink id="gmail-export">Gmail export</DocsTabLink>,{" "}
                            <DocsTabLink id="outlook-export">Outlook export</DocsTabLink>, and{" "}
                            <DocsTabLink id="meeting-notes-export">Meeting notes export</DocsTabLink>{" "} tabs.
                          </p>
                          <p className="text-sm text-muted leading-relaxed">
                            Jira&apos;s adapter reads issue summaries, descriptions, and comments within the
                            projects you scope it to (<code className="font-mono">--jira-projects</code>),
                            plus which Atlassian site to read from (
                            <code className="font-mono">--jira-cloud-id</code>). It never reads
                            project-wide or instance-wide, and it never touches assignee, reporter, watcher,
                            or custom field data, only the prose. Jira stores rich text as a structured
                            format rather than plain text; this adapter converts it to plain text on your
                            device before it ever reaches the privacy gate, dropping formatting and any
                            mentioned teammate&apos;s account id along the way, keeping only what they wrote.
                          </p>
                          <p className="text-sm text-muted leading-relaxed">
                            Sentry reads narrower than the other two on purpose. Point{" "}
                            <code className="font-mono">--mcp-sentry</code>{" "} at an org and a list of project
                            slugs and it reads each project&apos;s open issues, one draft rule candidate per
                            issue: the issue&apos;s own title, its status, and a link back to it in Sentry.
                            It never reads stack traces, breadcrumbs, event or user data, tags, counts, or
                            issue comments. Sentry&apos;s own MCP server doesn&apos;t expose issue comments
                            through a plain read-only tool call today, so this connector simply doesn&apos;t
                            read them rather than reach for a workaround.
                          </p>
                        </>
                      ),
                    },
                    {
                      label: "Figma comments",
                      content: (
                        <>
                          <p className="text-sm text-muted leading-relaxed">
                            <code className="font-mono">gnt connect figma</code>{" "} stores a personal access
                            token the same local-only way, and{" "}
                            <code className="font-mono">gnt prebrain --figma-comments</code>{" "} reads straight
                            from Figma&apos;s own REST API, not an MCP server. There&apos;s no first-party
                            Figma MCP tool that reads file comments at all, so this connects directly instead
                            of routing a token through a third-party wrapper. Point it at the exact files you
                            want scanned with <code className="font-mono">--figma-files</code> (comma-separated
                            file keys, taken from a file&apos;s own URL); it never discovers files or projects
                            on its own.
                          </p>
                          <p className="text-sm text-muted leading-relaxed">
                            Only a comment&apos;s own message text is ever read. The
                            commenter&apos;s name, avatar, and the comment&apos;s position on the canvas are
                            never touched, let alone chunked.
                          </p>
                          <TerminalBlock lines={FIGMA_COMMAND_LINES} copyText={FIGMA_COMMAND_COPY_TEXT} />
                        </>
                      ),
                    },
                    {
                      label: "Datadog notebooks",
                      content: (
                        <>
                          <p className="text-sm text-muted leading-relaxed">
                            <code className="font-mono">gnt connect datadog</code>{" "} stores an API key and
                            application key pair the same local-only way, and{" "}
                            <code className="font-mono">gnt prebrain --datadog-notebooks</code>{" "} reads straight
                            from Datadog&apos;s own REST API, not an MCP server. Datadog does publish one,
                            but only over a remote connection this CLI&apos;s local-first connectors don&apos;t
                            speak, so this reads directly instead. Point it at the exact notebooks you want
                            scanned with <code className="font-mono">--datadog-notebook-ids</code>{" "}
                            (comma-separated ids, taken from a notebook&apos;s own URL); it never lists or
                            discovers notebooks on its own.
                          </p>
                          <p className="text-sm text-muted leading-relaxed">
                            Only a notebook&apos;s title and its markdown
                            text cells are ever read. Graph, log, and monitor cells attached to the same
                            notebook are walked past and never chunked, and this connector never reads
                            metrics, monitor definitions, log data, or dashboards at all. Datadog generates
                            an incident postmortem as a notebook, so this same read path is how postmortem
                            write-ups come in too. The separate incident record itself (severity, affected
                            services, timeline) is never read.
                          </p>
                          <TerminalBlock lines={DATADOG_COMMAND_LINES} copyText={DATADOG_COMMAND_COPY_TEXT} />
                        </>
                      ),
                    },
                    {
                      label: "GitLab threads",
                      content: (
                        <>
                          <p className="text-sm text-muted leading-relaxed">
                            <code className="font-mono">gnt connect gitlab-threads</code>{" "} stores a project or
                            personal access token (scoped to <code className="font-mono">read_api</code>) the
                            same local-only way, and{" "}
                            <code className="font-mono">gnt prebrain --gitlab-threads</code>{" "} reads straight
                            from GitLab&apos;s own REST API, not an MCP server. GitLab does publish one, but
                            it&apos;s still Beta and authenticates with an interactive OAuth flow this CLI&apos;s
                            paste-a-token connectors don&apos;t speak, so this reads directly instead. Point it
                            at the exact projects you want scanned with{" "}
                            <code className="font-mono">--gitlab-projects</code> (comma-separated project ids
                            or &quot;namespace/project&quot; paths); it never discovers projects or groups on
                            its own.
                          </p>
                          <p className="text-sm text-muted leading-relaxed">
                            Only a merge request or issue&apos;s discussion threads are ever read.
                            The diff, file changes, and commit history are never touched, and a
                            system-generated audit-trail note (&quot;changed the description&quot;, &quot;assigned
                            to @user&quot;) is dropped outright rather than treated as something a person wrote.
                            Self-managed GitLab is supported with{" "}
                            <code className="font-mono">--gitlab-url</code>.
                          </p>
                          <TerminalBlock lines={GITLAB_COMMAND_LINES} copyText={GITLAB_COMMAND_COPY_TEXT} />
                        </>
                      ),
                    },
                    {
                      label: "HubSpot notes",
                      content: (
                        <>
                          <p className="text-sm text-muted leading-relaxed">
                            <code className="font-mono">gnt connect hubspot</code>{" "} stores a private app access
                            token the same local-only way, and{" "}
                            <code className="font-mono">gnt prebrain --hubspot-notes</code>{" "} reads straight from
                            HubSpot&apos;s own REST CRM API, not an MCP server. HubSpot&apos;s hosted MCP server
                            is OAuth-only with no static token this local-first connector can use, and its
                            self-hosted MCP package bundles read/write access across every CRM object behind
                            tools whose exact fields aren&apos;t independently verifiable, so this reads directly
                            instead of routing a token through either one. Point it at the exact deal pipelines
                            and/or teams you want scanned with{" "}
                            <code className="font-mono">--hubspot-pipelines</code>{" "} and{" "}
                            <code className="font-mono">--hubspot-teams</code> (comma-separated ids, at least one
                            required); it never discovers pipelines or teams on its own.
                          </p>
                          <TerminalBlock lines={HUBSPOT_COMMAND_LINES} copyText={HUBSPOT_COMMAND_COPY_TEXT} />
                          <p className="text-sm text-muted leading-relaxed">
                            Only a note&apos;s own written text is ever read: notes attached to a deal in a
                            scoped pipeline, and notes owned by a scoped team&apos;s members. Contact records,
                            company records, and a deal&apos;s own fields (amount, stage, close date) are never
                            read. Deals and owners are only ever looked up by id to find the right notes, never
                            for their own properties. Playbook content has no public HubSpot API today, so this
                            connector doesn&apos;t read it rather than reach for a workaround.
                          </p>
                          <p className="text-sm text-muted leading-relaxed">
                            Same as every other prebrain walker: everything above happens on your device before
                            the privacy gate runs, and only masked text ever reaches extraction.
                          </p>
                        </>
                      ),
                    },
                    {
                      label: "Airtable",
                      content: (
                        <>
                          <p className="text-sm text-muted leading-relaxed">
                            <code className="font-mono">gnt connect airtable</code>{" "} is interactive, not a
                            single pasted token: paste a personal access token, pick which base to connect,
                            then for each table you want scanned, see its real fields live and explicitly
                            choose which ones are safe prose. A table you skip, or leave with no fields
                            picked, is never read. That choice matters more here than for any other
                            connector on this page: a base&apos;s fields are entirely up to whoever built
                            it, so there&apos;s no fixed shape to trust the way a Figma comment or a Datadog
                            notebook has. <code className="font-mono">gnt prebrain --airtable</code>{" "} then
                            reads straight from Airtable&apos;s own REST API, not an MCP server, and only
                            ever reads the exact fields picked at connect time. A field nobody picked is
                            structurally unreachable, not just unread, and a table with zero fields picked
                            is never queried at all. Unlike every other connector here, it takes no
                            per-run scope flags: the base, the tables, and the field selection are all
                            decided once, in <code className="font-mono">gnt connect airtable</code>{" "} itself.
                          </p>
                          <TerminalBlock lines={AIRTABLE_COMMAND_LINES} copyText={AIRTABLE_COMMAND_COPY_TEXT} />
                        </>
                      ),
                    },
                    {
                      label: "Zendesk",
                      content: (
                        <>
                          <p className="text-sm text-muted leading-relaxed">
                            Zendesk is different from every other connector on this page: it runs on gnt&apos;s
                            own server, not your device. Everything else above (Figma, Datadog, the MCP-in
                            walkers on the other tabs) is <code className="font-mono">gnt prebrain</code>{" "}
                            reading locally, from your machine, through the CLI-side privacy gate. Zendesk
                            support content changes continuously, so this connects once and syncs on a nightly
                            schedule instead. A customer support token, generated self-serve in your own
                            Zendesk admin (no app review), is stored encrypted on gnt&apos;s server and read by a
                            scheduled job.
                          </p>
                          <p className="text-sm text-muted leading-relaxed">
                            What it reads: macros (the canned-reply text agents insert, not what they trigger),
                            internal notes on tickets (the non-public ones agents leave for each other, never a
                            reply the customer sees), and help-center article bodies. Prose only, in all three
                            cases.
                          </p>
                          <p className="text-sm text-muted leading-relaxed">
                            What it never reads: the ticket record itself. No requester, no custom fields, no
                            contact info, no subject line, no priority or status, no satisfaction rating.
                            The adapter that talks to Zendesk&apos;s API is written so those fields are
                            structurally unreachable, not just filtered out after the fact.
                          </p>
                          <p className="text-sm text-muted leading-relaxed">
                            Because this runs server-side, every piece of content gnt reads is masked by the
                            same privacy gate the webhook path above uses. That masking is permanent, done
                            before extraction ever sees it, the same way Slack&apos;s <code className="font-mono">/brain</code>{" "}
                            command is masked on arrival. Extraction turns masked macro/note/article text into
                            candidate rules, which land in your normal review queue exactly like any other draft.
                            Nothing is ever auto-approved. Disconnecting removes the stored credential
                            immediately.
                          </p>
                        </>
                      ),
                    },
                    {
                      label: "Intercom",
                      content: (
                        <>
                          <p className="text-sm text-muted leading-relaxed">
                            Intercom is different from every other connector on this page: it runs on gnt&apos;s
                            own server, not your device. Everything else above (Figma, Datadog, the MCP-in
                            walkers on the other tabs) is <code className="font-mono">gnt prebrain</code>{" "}
                            reading locally, from your machine, through the CLI-side privacy gate. Support
                            content in Intercom changes continuously, so this connects once and syncs on a
                            nightly schedule instead. An access token, generated self-serve in your own
                            workspace&apos;s Developer Hub (no app review), is stored encrypted on gnt&apos;s
                            server and read by a scheduled job.
                          </p>
                          <p className="text-sm text-muted leading-relaxed">
                            What it reads: saved replies (the canned-reply text agents insert, not who can use
                            them), internal notes on conversations (the teammate-only notes agents leave for
                            each other, never a reply the customer sees), and help-center article bodies. Prose
                            only, in all three cases.
                          </p>
                          <p className="text-sm text-muted leading-relaxed">
                            What it never reads: the contact record itself. No email, no phone number, no name,
                            no custom attributes, no company or segment membership. The adapter that
                            talks to Intercom&apos;s API is written so those fields are structurally
                            unreachable, not just filtered out after the fact.
                          </p>
                          <p className="text-sm text-muted leading-relaxed">
                            Because this runs server-side, every piece of content gnt reads is masked by the
                            same privacy gate the webhook path above uses. That masking is permanent, done
                            before extraction ever sees it, the same way Slack&apos;s <code className="font-mono">/brain</code>{" "}
                            command is masked on arrival. Extraction turns masked reply/note/article text into
                            candidate rules, which land in your normal review queue exactly like any other draft.
                            Nothing is ever auto-approved. Disconnecting removes the stored credential
                            immediately.
                          </p>
                        </>
                      ),
                    },
                  ]}
                />
              </div>
            ),
          },
          {
            id: "granola-mcp",
            label: "Granola",
            content: (
              <div className="flex flex-col gap-8">
                <h1 className="font-mono text-2xl font-bold tracking-tight">Granola</h1>
                <p className="text-sm text-muted leading-relaxed">
                  <code className="font-mono">gnt prebrain --mcp-granola</code>{" "} reads meeting notes
                  and transcripts straight out of Granola, scoped to the folders you choose, through
                  Granola&apos;s own MCP server. No export file, no gnt server in the read path.
                </p>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Connect it</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Granola&apos;s MCP server authenticates with a one-time browser sign-in, not a
                    pasted API key. <code className="font-mono">gnt connect granola-mcp</code>{" "}
                    walks you through it, then checks the connection with one real read before
                    saving anything.
                  </p>
                  <TerminalBlock lines={GRANOLA_CONNECT_LINES} copyText={GRANOLA_CONNECT_COPY_TEXT} />
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Scope it to folders</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    <code className="font-mono">--granola-folders</code>{" "} takes one or more Granola
                    folder ids, comma-separated. This connector never discovers folders on its own
                    and never reads outside the folders you name.
                  </p>
                  <TerminalBlock lines={GRANOLA_COMMAND_LINES} copyText={GRANOLA_COMMAND_COPY_TEXT} />
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">What it reads, and what it never does</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    For each meeting in a folder you scoped, it reads the verbatim transcript and
                    Granola&apos;s own AI-written notes/summary. It never reads attendee lists,
                    account/workspace identity, or anything from outside the folders you named.
                    Those fields are stripped before this connector&apos;s own code ever runs, not
                    just left unused.
                  </p>
                  <p className="text-sm text-muted leading-relaxed">
                    Same as every other prebrain walker: everything above happens on your device
                    before the privacy gate runs, and only masked text ever reaches extraction.
                  </p>
                </div>
              </div>
            ),
          },
          {
            id: "zoom-mcp",
            label: "Zoom",
            content: (
              <div className="flex flex-col gap-8">
                <h1 className="font-mono text-2xl font-bold tracking-tight">Zoom</h1>
                <p className="text-sm text-muted leading-relaxed">
                  <code className="font-mono">gnt prebrain --mcp-zoom</code>{" "} reads recording
                  transcripts straight out of Zoom, scoped to the hosts and date range you choose,
                  through Zoom&apos;s own MCP server. No gnt server in the read path.
                </p>
                <p className="text-sm text-muted leading-relaxed">
                  Needs a paid Zoom Pro plan or higher for every host you scope this to &mdash;
                  Zoom&apos;s free Basic tier has no cloud recording at all, so there&apos;s no
                  transcript for this connector to read. Check with whoever owns your Zoom account
                  before running this.
                </p>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Connect it</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Zoom&apos;s MCP server authenticates with a user OAuth access token, not a
                    permanent API key. Create a Zoom Marketplace &quot;General App&quot; (not
                    Server-to-Server OAuth), complete its authorization once, and paste the
                    resulting token into <code className="font-mono">gnt connect zoom-mcp</code>,
                    which checks the connection with one real read before saving anything. That
                    token is short-lived (about an hour), so you&apos;ll reconnect with a fresh one
                    periodically rather than once and done.
                  </p>
                  <TerminalBlock lines={ZOOM_CONNECT_LINES} copyText={ZOOM_CONNECT_COPY_TEXT} />
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Scope it to hosts and a date range</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    <code className="font-mono">--zoom-hosts</code>{" "} takes one or more Zoom host user
                    ids or emails, comma-separated, and is required. <code className="font-mono">--zoom-from</code>{" "}
                    / <code className="font-mono">--zoom-to</code>{" "} narrow the recordings pulled for
                    each host; leave them off and it reads just that day&apos;s recordings, never a
                    host&apos;s entire history by default.
                  </p>
                  <TerminalBlock lines={ZOOM_COMMAND_LINES} copyText={ZOOM_COMMAND_COPY_TEXT} />
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">What it reads, and what it never does</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    For each recording a scoped host has in range, it reads the verbatim transcript
                    only. It never reads whiteboards, Zoom Docs, agenda documents, participant
                    lists, chat search, or any recording belonging to a host you didn&apos;t
                    name. Those fields and tools are stripped or simply never called, not just
                    left unused.
                  </p>
                  <p className="text-sm text-muted leading-relaxed">
                    Same as every other prebrain walker: everything above happens on your device
                    before the privacy gate runs, and only masked text ever reaches extraction.
                  </p>
                </div>
              </div>
            ),
          },
          {
            id: "gmail-export",
            label: "Gmail export",
            content: (
              <div className="flex flex-col gap-8">
                <h1 className="font-mono text-2xl font-bold tracking-tight">Gmail export</h1>
                <p className="text-sm text-muted leading-relaxed">
                  Gmail&apos;s own OAuth connector needs Google&apos;s app-review process, which runs
                  on Google&apos;s timeline, not yours. Until that clears,{" "}
                  <code className="font-mono">gnt prebrain --gmail</code>{" "} reads a Google Takeout mail
                  export instead, no approval required, no gnt server ever in the read path.
                </p>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Produce the export</h2>
                  <ol className="flex flex-col gap-2 text-sm text-muted leading-relaxed list-decimal pl-5">
                    <li>
                      Go to <span className="text-foreground">takeout.google.com</span>{" "} signed into
                      the account you want to export.
                    </li>
                    <li>
                      Click <span className="text-foreground">Deselect all</span>, then check only{" "}
                      <span className="text-foreground">Mail</span>.
                    </li>
                    <li>
                      Click <span className="text-foreground">All Mail data included</span>{" "} next to
                      Mail to open the label picker, and check only the labels you actually want
                      scanned instead of leaving every label selected. This is the cleanest way to
                      scope a whole mailbox down before anything reaches your device.
                    </li>
                    <li>
                      Choose <span className="text-foreground">Export once</span>{" "} and{" "}
                      <span className="text-foreground">.zip</span>.
                    </li>
                    <li>
                      Once the export lands and you&apos;ve unzipped it, point{" "}
                      <code className="font-mono">--gmail</code>{" "} at the single{" "}
                      <code className="font-mono">.mbox</code>{" "} file inside{" "}
                      <code className="font-mono">Takeout/Mail/</code>, not the outer .zip.
                    </li>
                  </ol>
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Scope it with flags</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Didn&apos;t label-filter the export, or want to scope it further? Bound the date
                    range and sender with <code className="font-mono">--gmail-since</code>/
                    <code className="font-mono">--gmail-until</code> (YYYY-MM-DD) and{" "}
                    <code className="font-mono">--gmail-from</code> (comma-separated addresses or
                    domains). A malformed date skips the walker entirely rather than silently running
                    it unscoped.
                  </p>
                  <TerminalBlock lines={GMAIL_COMMAND_LINES} copyText={GMAIL_COMMAND_COPY_TEXT} />
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">What it reads, and what it never does</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Messages are reconstructed into threads using each message&apos;s Message-ID,
                    In-Reply-To, and References headers, so a reply is read with its context instead
                    of alone. HTML bodies are converted to plain text. Quoted history a reply carries
                    along (the &quot;On ... wrote:&quot; block, or a client&apos;s own quoted-thread
                    styling) is stripped, so a long thread doesn&apos;t get reprocessed once per
                    reply. Each message keeps only its own new content.
                  </p>
                  <p className="text-sm text-muted leading-relaxed">
                    Attachments are never opened. If a message has one, its filename is kept for
                    context and nothing else about it is read.
                  </p>
                  <p className="text-sm text-muted leading-relaxed">
                    Same as every other prebrain walker: everything above happens on your device
                    before the privacy gate runs, and only masked text ever reaches extraction.
                  </p>
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Local docs folder, including a synced Dropbox folder</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    <code className="font-mono">gnt prebrain --docs &lt;path&gt;</code>{" "} walks any
                    directory on your machine for markdown and text files and turns matching prose
                    into draft rules, through the same local privacy gate as every other source.
                    Point it at a folder Dropbox&apos;s desktop client keeps synced and it works
                    the same way, gnt only reads whatever has already landed on disk; Dropbox is
                    what keeps that folder current, gnt never talks to Dropbox directly.
                  </p>
                  <p className="text-sm text-muted leading-relaxed">
                    Two things it handles for you in a synced folder specifically. It never reads
                    into <code className="font-mono">.dropbox.cache</code>, Dropbox&apos;s own local
                    staging directory, the same way it skips any other hidden directory. And it
                    recognizes Dropbox&apos;s conflicted-copy naming, files renamed like{" "}
                    <code className="font-mono">notes (jordan&apos;s conflicted copy 2026-07-18).md</code>,{" "}
                    <code className="font-mono">notes (Case Conflict).md</code>, or{" "}
                    <code className="font-mono">notes (Unicode Encoding Conflict).md</code>{" "} when
                    Dropbox detects the same file was edited on two devices. Only the original,
                    untagged filename is ingested, the tagged copy is skipped, so the same edit
                    doesn&apos;t get read twice or, worse, get read as two documents that disagree
                    with each other. If a tagged copy holds a change the original doesn&apos;t,
                    resolve the conflict in Dropbox first, a directory listing alone can&apos;t
                    tell which side you meant to keep.
                  </p>
                </div>
              </div>
            ),
          },
          {
            id: "outlook-export",
            label: "Outlook export",
            content: (
              <div className="flex flex-col gap-8">
                <h1 className="font-mono text-2xl font-bold tracking-tight">Outlook export</h1>
                <p className="text-sm text-muted leading-relaxed">
                  Outlook&apos;s own OAuth connector needs Microsoft&apos;s app-review process, the
                  same story as Gmail&apos;s. Until that clears,{" "}
                  <code className="font-mono">gnt prebrain --outlook</code>{" "} reads a portable Outlook
                  export instead, no approval required, no gnt server ever in the read path.
                </p>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Produce the export</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Outlook has no single-click whole-mailbox export to a portable format. What it
                    does support natively is per message: open a message in Outlook on the web or
                    new Outlook for Windows, open the message actions menu, and choose{" "}
                    <span className="text-foreground">Download</span> &rarr;{" "}
                    <span className="text-foreground">Download as EML</span> (Outlook on the web) or{" "}
                    <span className="text-foreground">Save as</span> (new Outlook for Windows). Each
                    one writes a single <code className="font-mono">.eml</code>{" "} file. Repeat across
                    the messages you want scanned, put them all in one folder, then point{" "}
                    <code className="font-mono">--outlook</code>{" "} at that folder.
                  </p>
                  <p className="text-sm text-muted leading-relaxed">
                    For more than a handful of messages, script it against the Graph API instead:{" "}
                    <code className="font-mono">GET /me/messages/{"{id}"}/$value</code>{" "} returns a
                    message&apos;s raw MIME content, exactly what a{" "}
                    <code className="font-mono">.eml</code>{" "} file holds. Loop it over a folder&apos;s
                    message ids and write each response to its own file.
                  </p>
                  <p className="text-sm text-muted leading-relaxed">
                    <span className="text-foreground">Not supported:</span>{" "} classic Outlook for
                    Windows&apos; Import/Export wizard, which only writes{" "}
                    <code className="font-mono">.pst</code>, Microsoft&apos;s proprietary binary
                    mailbox format. Parsing it would mean reverse-engineering a closed binary format
                    instead of reading a documented text one, so{" "}
                    <code className="font-mono">--outlook</code>{" "} never attempts it. If a{" "}
                    <code className="font-mono">.pst</code>{" "} file is all you have, open it in classic
                    Outlook and use the per-message export above, or bridge it through another mail
                    client that can read PST and export EML or mbox.
                  </p>
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">mbox works too, if you already have one</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Outlook itself never produces an <code className="font-mono">.mbox</code>{" "} file,
                    but if you bridged the mailbox through a tool that does (syncing it over IMAP
                    into another mail client and exporting from there, for example), point{" "}
                    <code className="font-mono">--outlook</code>{" "} at that single file instead of a
                    folder. It&apos;s detected automatically and read the same way{" "}
                    <code className="font-mono">--gmail</code>{" "} reads a Takeout export.
                  </p>
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Scope it with flags</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Bound the date range and sender with{" "}
                    <code className="font-mono">--outlook-since</code>/
                    <code className="font-mono">--outlook-until</code> (YYYY-MM-DD) and{" "}
                    <code className="font-mono">--outlook-from</code> (comma-separated addresses or
                    domains). A malformed date skips the walker entirely rather than silently running
                    it unscoped.
                  </p>
                  <TerminalBlock lines={OUTLOOK_COMMAND_LINES} copyText={OUTLOOK_COMMAND_COPY_TEXT} />
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">What it reads, and what it never does</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Same parsing and thread reconstruction as the Gmail export walker: messages are
                    reconstructed into threads using each message&apos;s Message-ID, In-Reply-To, and
                    References headers, HTML bodies are converted to plain text, and quoted history a
                    reply carries along is stripped, so a long thread doesn&apos;t get reprocessed
                    once per reply.
                  </p>
                  <p className="text-sm text-muted leading-relaxed">
                    Attachments are never opened. If a message has one, its filename is kept for
                    context and nothing else about it is read.
                  </p>
                  <p className="text-sm text-muted leading-relaxed">
                    Same as every other prebrain walker: everything above happens on your device
                    before the privacy gate runs, and only masked text ever reaches extraction.
                  </p>
                </div>
              </div>
            ),
          },
          {
            id: "meeting-notes-export",
            label: "Meeting notes export",
            content: (
              <div className="flex flex-col gap-8">
                <h1 className="font-mono text-2xl font-bold tracking-tight">Meeting notes export</h1>
                <p className="text-sm text-muted leading-relaxed">
                  <code className="font-mono">gnt prebrain --meeting-notes</code>{" "} reads meeting-transcript
                  exports from Otter, Fireflies, or Fathom. Point it at a directory or a single file
                  and it auto-detects each file&apos;s shape, no per-tool flag needed, no gnt server
                  ever in the read path.
                </p>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Otter</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Open a conversation, use the export option in its menu, and choose a format. Every
                    plan can export <span className="text-foreground">TXT</span>; paid plans add{" "}
                    <span className="text-foreground">DOCX</span>, <span className="text-foreground">
                    PDF</span>, and <span className="text-foreground">SRT</span>. Either TXT or SRT
                    works here, no need to pick one over the other for this to read it.
                  </p>
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Fireflies</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    From a meeting&apos;s notepad, use the download option and choose a format:{" "}
                    <span className="text-foreground">DOCX</span>,{" "}
                    <span className="text-foreground">PDF</span>,{" "}
                    <span className="text-foreground">SRT</span>,{" "}
                    <span className="text-foreground">CSV</span>,{" "}
                    <span className="text-foreground">JSON</span>, or{" "}
                    <span className="text-foreground">MD</span>. SRT or MD both work here; turn on the
                    timestamp and speaker-label toggles if the export screen offers them, since a
                    transcript reads better with both.
                  </p>
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Fathom</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    Fathom has no file export at all. From a recorded call, the{" "}
                    <span className="text-foreground">Copy Transcript</span>{" "} button above the
                    transcript copies it to your clipboard, and that&apos;s the only built-in path.
                    Paste it into a plain text file and save it with a{" "}
                    <code className="font-mono">.txt</code>{" "} extension, then point{" "}
                    <code className="font-mono">--meeting-notes</code>{" "} at the folder you&apos;re saving
                    those into.
                  </p>
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Point it at your exports</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    A directory of exported files, or a single file, both work.{" "}
                    <code className="font-mono">.vtt</code>, <code className="font-mono">.srt</code>,{" "}
                    <code className="font-mono">.txt</code>, and <code className="font-mono">.md</code>{" "}
                    files are read; which one a given file actually is gets sniffed from its own
                    content, not trusted from its extension, so a mislabeled file still parses
                    correctly.
                  </p>
                  <TerminalBlock lines={MEETING_NOTES_COMMAND_LINES} copyText={MEETING_NOTES_COMMAND_COPY_TEXT} />
                </div>

                <div className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">What it reads, and what it never does</h2>
                  <p className="text-sm text-muted leading-relaxed">
                    A cue-timestamped file (SRT, or VTT if a tool you bridge through produces one) has
                    its cues merged back into full spoken turns before anything else happens --
                    caption exports slice a single sentence across several short cues, and reading
                    each cue as its own turn would fragment ordinary dialogue and misread where one
                    person stopped talking and another started. A plain-text file&apos;s speaker and
                    timestamp markup is read the same way, whichever of Otter&apos;s, Fireflies&apos;,
                    or Fathom&apos;s line shapes it uses.
                  </p>
                  <p className="text-sm text-muted leading-relaxed">
                    Same as every other prebrain walker: everything above happens on your device
                    before the privacy gate runs, and only masked text ever reaches extraction.
                  </p>
                </div>
              </div>
            ),
          },
        ]}
      />

      <MarketingFooter />
    </div>
  );
}

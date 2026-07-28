"use client";

import { useState } from "react";
import { AgentOnboardBlock } from "@/components/agent-onboard-block";
import { TerminalBlock } from "@/components/terminal-block";

const MANUAL_LINES = [
  "$ npm install -g @gnt-ai/cli",
  "$ gnt login",
  "$ gnt connect slack",
  "$ gnt connect github",
  "$ gnt prebrain",
  "$ gnt review",
];

const MANUAL_COPY_TEXT = MANUAL_LINES.join("\n");

const MANUAL_STEPS = [
  { label: "Install", desc: "Pulls the gnt CLI down globally." },
  { label: "Sign in", desc: "Connects it to this account." },
  { label: "Connect Slack", desc: "Optional. Connects a Slack workspace to this org." },
  {
    label: "Connect GitHub",
    desc: "Required. Opens a browser to install our GitHub App on the repo rules PRs open against.",
  },
  {
    label: "Run prebrain",
    desc: "Scans this repo and opens your first rules as pull requests. Add --all to pull from every source you've connected (Notion, Linear, Jira, GitLab, Figma, and more — see `gnt connect --help` for exact command names), or scope it to just one with e.g. --mcp-notion. Asks a few quick questions about the company first.",
  },
  {
    label: "Review",
    desc: "Optional. Turns any rules added outside prebrain into pull requests for you to merge on GitHub.",
  },
];

type Path = "agent" | "manual";

// A toggle, not two full sections stacked -- welcome used to render both
// Path A (agent) and Path B (manual, a 6-line terminal block plus a
// 6-item step list) fully expanded at once, which alone pushed this page
// well past a single viewport. Only one path is ever the one someone
// actually follows; showing both at once cost height for no reason.
// Defaults to "agent" -- the recommended path -- so the common case stays
// short too.
export function OnboardingPaths() {
  const [path, setPath] = useState<Path>("agent");

  return (
    <div className="w-full flex flex-col gap-3">
      <div role="tablist" aria-label="Setup path" className="inline-flex self-start gap-0.5 border border-border p-0.5">
        <button
          type="button"
          role="tab"
          aria-selected={path === "agent"}
          onClick={() => setPath("agent")}
          className={
            path === "agent"
              ? "rounded-[4px] bg-accent-brand px-3 py-1.5 font-mono text-xs font-medium text-accent-brand-foreground"
              : "rounded-[4px] px-3 py-1.5 font-mono text-xs font-medium text-muted transition-colors duration-150 ease-out-strong hover:text-foreground"
          }
        >
          Agent-driven
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={path === "manual"}
          onClick={() => setPath("manual")}
          className={
            path === "manual"
              ? "rounded-[4px] bg-accent-brand px-3 py-1.5 font-mono text-xs font-medium text-accent-brand-foreground"
              : "rounded-[4px] px-3 py-1.5 font-mono text-xs font-medium text-muted transition-colors duration-150 ease-out-strong hover:text-foreground"
          }
        >
          Manual
        </button>
      </div>

      {path === "agent" ? (
        <div className="flex flex-col gap-3">
          <p className="font-mono text-sm text-muted">
            Paste this into Claude Code, Cursor, or any AI coding agent. It reads the setup doc and configures
            gnt.ai for your team: CLI, Slack, and GitHub, all in one go.
          </p>
          <AgentOnboardBlock />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="font-mono text-sm text-muted">Same result, one command at a time.</p>
          <TerminalBlock lines={MANUAL_LINES} copyText={MANUAL_COPY_TEXT} />
          {/* Capped and internally scrollable -- six full steps read as a
              wall on a page that's supposed to fit one viewport; the
              terminal block above already carries the commands
              themselves, this list is reference detail someone can
              scroll for, not the first thing that needs to be visible. */}
          <ol className="flex max-h-40 flex-col gap-2 overflow-y-auto pr-1">
            {MANUAL_STEPS.map((step, i) => (
              <li key={step.label} className="flex gap-3 font-mono text-sm leading-relaxed">
                <span className="text-muted shrink-0">{i + 1}.</span>
                <p>
                  <span className="font-bold">{step.label}.</span> <span className="text-muted">{step.desc}</span>
                </p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

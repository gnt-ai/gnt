"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

// button-tab / button-tab-active + install-snippet from the OpenCode
// reference doc. Real alternate install methods, not invented ones --
// curl runs public/install.sh (checks Node, then npm-installs under the
// hood -- it's the same npm package, just one line), brew installs from
// gnt-ai/homebrew-tap (also just wraps the npm package, see that tap's
// own formula), npm is the direct/explicit path for anyone who'd rather
// see exactly what's running. Deliberately not also listing bun/pnpm/yarn
// variants -- same install, different prefix, and a 6-tab row wrapped
// illegibly on a 375px viewport with no scroll affordance; three real,
// distinct install experiences beats six that are mostly the same
// command with a different package manager name on it.
const METHODS = [
  { id: "curl", command: "curl -fsSL gntai.dev/install.sh | sh" },
  { id: "brew", command: "brew install gnt-ai/tap/gnt" },
  { id: "npm", command: "npm install -g @gnt-ai/cli" },
] as const;

export function InstallTabs() {
  const [active, setActive] = useState<(typeof METHODS)[number]["id"]>("curl");
  const [copied, setCopied] = useState(false);
  const command = METHODS.find((m) => m.id === active)!.command;

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="w-full border border-border rounded-[4px] overflow-hidden">
      <div className="flex items-center border-b border-border">
        {METHODS.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setActive(m.id)}
            className={`px-4 py-2 font-mono text-sm font-medium border-b-2 -mb-px transition-colors duration-150 ease-out-strong ${
              active === m.id
                ? "text-foreground border-muted"
                : "text-muted border-transparent hover:text-foreground"
            }`}
          >
            {m.id}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 bg-surface px-4 py-3">
        <code className="font-mono text-sm overflow-x-auto whitespace-nowrap">
          {command}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy install command"}
          aria-live="polite"
          className="shrink-0 text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

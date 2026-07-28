"use client";

import { useState } from "react";

// Same border/bg-surface/padding/corner-radius everywhere -- the homepage
// hero and the docs page examples should look like the same component,
// not two different treatments. Used to have a `square` variant for the
// homepage specifically (flush against the page's own bordered frame,
// sharp corners to match) -- dropped once the homepage moved to the same
// px-6 inset every other element on the page already uses instead of
// sitting flush against the frame border, which was the only reason this
// component needed a second style at all.
export function TerminalBlock({ lines, copyText }: { lines: string[]; copyText: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="w-full text-left border border-border bg-surface rounded-[4px]">
      <div className="flex items-center justify-between py-2 px-4 border-b border-border">
        <div aria-hidden="true" className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-surface-highest" />
          <span className="h-2.5 w-2.5 rounded-full bg-surface-highest" />
          <span className="h-2.5 w-2.5 rounded-full bg-surface-highest" />
        </div>
        <button
          type="button"
          onClick={copy}
          aria-live="polite"
          className="font-mono text-xs uppercase tracking-widest text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="relative">
        {/* text-sm flat, not text-xs sm:text-sm -- 12px on mobile was hard
            to read, especially for the longer wrapped lines (JSON output,
            the mcp add command). */}
        <pre className="pt-4 pb-6 px-4 font-mono text-sm leading-relaxed overflow-x-auto">
          {lines.map((line, i) => (
            <div key={i} className={line.startsWith("✓") ? "text-success" : "text-foreground"}>
              {line.startsWith("$") ? (
                <>
                  <span className="text-muted">$ </span>
                  {line.slice(2)}
                </>
              ) : (
                line || " "
              )}
              {/* A static idle cursor on the last line reads as "this terminal
                  is live", without the typing animation's timing/complexity. */}
              {i === lines.length - 1 && (
                <span aria-hidden="true" className="cursor-blink text-foreground">
                  ▋
                </span>
              )}
            </div>
          ))}
        </pre>
        {/* Signals there's more to scroll on narrow viewports, where long
            lines (the JSON output, the wrapped mcp add command) overflow
            and would otherwise look like they're just cut off. Desktop's
            wider max-w container fits every line already, so this only
            renders below sm: where the overflow is actually real. */}
        <div className="pointer-events-none absolute inset-y-0 right-0 block w-8 bg-gradient-to-l from-surface to-transparent sm:hidden" />
      </div>
    </div>
  );
}

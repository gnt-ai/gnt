"use client";

import { useState } from "react";

// For real source-code listings (a Python file, not a command+output
// transcript) -- TerminalBlock's "$" prompt styling is a mismatch for
// these, and a wall of same-color monospace is hard to scan at length.
// Line numbers + a language label + light comment/string tinting, no
// full tokenizing highlighter (no new dependency, and our snippets only
// ever need these few token classes to read clearly).
function highlight(line: string): React.ReactNode {
  const commentIdx = line.indexOf("#");
  const code = commentIdx === -1 ? line : line.slice(0, commentIdx);
  const comment = commentIdx === -1 ? null : line.slice(commentIdx);

  // Split the code portion on quoted strings, keeping the quotes in the
  // result so alternating segments are plain/string/plain/string/...
  const parts = code.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g);

  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          // Not --success -- that's calibrated for TerminalBlock's always-
          // dark surface. --code-string is its own theme-aware pair,
          // measured to pass WCAG AA (4.5:1) against CodeCard's actual
          // light AND dark surface, see globals.css.
          <span key={i} className="text-code-string">
            {part}
          </span>
        ) : (
          part
        ),
      )}
      {comment !== null && <span className="text-muted">{comment}</span>}
    </>
  );
}

export function CodeCard({
  lines,
  copyText,
  language,
}: {
  lines: string[];
  copyText: string;
  language: string;
}) {
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
    <div className="w-full text-left border border-border rounded-[4px] overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="font-mono text-xs uppercase tracking-widest text-muted">{language}</span>
        <button
          type="button"
          onClick={copy}
          aria-live="polite"
          className="font-mono text-xs uppercase tracking-widest text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {/* text-sm flat -- same reasoning as TerminalBlock, 12px code is a
          real legibility problem, not just a stylistic choice. */}
      <pre className="overflow-x-auto px-4 py-4 font-mono text-sm leading-relaxed bg-surface">
        {lines.map((line, i) => (
          <div key={i} className="flex gap-4">
            <span aria-hidden="true" className="select-none text-muted/60 text-right w-6 shrink-0">
              {i + 1}
            </span>
            <span className="text-foreground whitespace-pre">{highlight(line) || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

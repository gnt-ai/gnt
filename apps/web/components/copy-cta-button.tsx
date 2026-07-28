"use client";

import { useState } from "react";
import { Check, Terminal, X } from "lucide-react";

type Status = "idle" | "copied" | "failed";

export function CopyCtaButton({ command, label }: { command: string; label: string }) {
  const [status, setStatus] = useState<Status>("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    setTimeout(() => setStatus("idle"), 1500);
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-live="polite"
      className="inline-flex items-center gap-2 rounded-[4px] bg-accent-brand px-5 py-1 font-mono text-sm font-medium leading-[2] text-accent-brand-foreground hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong"
    >
      {status === "copied" && <Check className="h-4 w-4" />}
      {status === "failed" && <X className="h-4 w-4" />}
      {status === "idle" && <Terminal className="h-4 w-4" />}
      {status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : label}
    </button>
  );
}

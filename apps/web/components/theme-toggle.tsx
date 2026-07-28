"use client";

import { Moon, Sun } from "lucide-react";

const STORAGE_KEY = "gnt-theme";

export function ThemeToggle() {
  function toggle() {
    const root = document.documentElement;
    const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable (private browsing, disabled) -- the toggle
      // still works for the session, it just won't persist across visits.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle color theme"
      className="flex h-8 w-8 items-center justify-center text-muted hover:text-foreground transition-colors duration-150 ease-out-strong"
    >
      {/* Both icons always render -- which one is visible is decided by
          globals.css reacting to data-theme, not React state. The inline
          script in layout.tsx sets data-theme before first paint, so
          there's nothing to read-and-branch on the client after mount:
          reading it into useState would need an effect, which either
          flashes the wrong icon for a frame or (if read during the
          initial render) mismatches the server-rendered placeholder.
          Pure CSS has neither problem. */}
      <Sun className="icon-to-light h-4 w-4" aria-hidden="true" />
      <Moon className="icon-to-dark h-4 w-4" aria-hidden="true" />
    </button>
  );
}

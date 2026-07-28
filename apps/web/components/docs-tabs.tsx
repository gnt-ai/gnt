"use client";

import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";

export type DocsTab = { id: string; label: string; content: ReactNode };

// Lets a link inside one tab's content (e.g. Connect's "jump back up" to
// Quickstart) switch tabs instead of scrolling -- there's nothing to
// scroll to anymore, the other tab's content isn't even mounted.
const SelectTabContext = createContext<((id: string) => void) | null>(null);

export function DocsTabLink({ id, children }: { id: string; children: ReactNode }) {
  const selectTab = useContext(SelectTabContext);
  return (
    <button
      type="button"
      onClick={() => selectTab?.(id)}
      className="underline underline-offset-4 decoration-border hover:text-foreground transition-colors"
    >
      {children}
    </button>
  );
}

function subscribeToHash(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

function getHashSnapshot() {
  return window.location.hash.slice(1);
}

function getServerHashSnapshot() {
  // No location during SSR -- render the default tab there, same as the
  // client's very first paint (useSyncExternalStore reconciles the two
  // without a hydration mismatch, then re-renders once the real client
  // hash is available).
  return "";
}

// Docs used to be one long scrolling page with a sub-nav that jumped
// between anchors. Now only the selected tab's content renders -- the
// nav swaps state instead of scrolling, Quickstart is the default, and
// the panel fades/rises in on change (.animate-tab-in, globals.css).
// Hash-synced (#tools, #enforce, ...) so a saved link still lands on the
// right tab instead of always resetting to Quickstart. No separate page
// title above the panel -- each tab's own heading (an h1, in its content)
// carries that job, since only one is ever visible at a time.
export function DocsTabs({ tabs }: { tabs: DocsTab[] }) {
  const hash = useSyncExternalStore(subscribeToHash, getHashSnapshot, getServerHashSnapshot);
  const hashTabId = tabs.some((tab) => tab.id === hash) ? hash : null;
  // Once picked by hand, a click always wins over the (static, load-time)
  // hash -- selectTab below only updates the URL for shareability, it
  // doesn't feed back into this via a hashchange (replaceState is silent).
  const [manualId, setManualId] = useState<string | null>(null);
  const activeId = manualId ?? hashTabId ?? tabs[0].id;

  function selectTab(id: string) {
    setManualId(id);
    window.history.replaceState(null, "", `#${id}`);
  }

  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  return (
    <>
      {/* Same max-w-3xl + sm:border-x frame as the homepage (see the
          comment above its own content frame in page.tsx) -- the nav and
          main are separate elements but share the same centered max-w-3xl,
          so their hairlines land at the same x-position. */}
      <div className="sticky top-0 z-10 bg-shell/95 backdrop-blur border-b border-border">
        <nav
          role="tablist"
          className="flex flex-wrap items-center gap-x-5 gap-y-2 px-6 py-3 max-w-3xl w-full mx-auto sm:border-x sm:border-border font-mono text-sm uppercase tracking-widest text-muted"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`docs-tab-${tab.id}`}
              aria-selected={tab.id === activeId}
              aria-controls="docs-tabpanel"
              onClick={() => selectTab(tab.id)}
              className={
                tab.id === activeId
                  ? "whitespace-nowrap text-foreground transition-colors duration-150 ease-out-strong"
                  : "whitespace-nowrap hover:text-foreground transition-colors duration-150 ease-out-strong"
              }
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      <main className="flex-1 px-6 py-10 max-w-3xl w-full mx-auto sm:border-x sm:border-border">
        <SelectTabContext.Provider value={selectTab}>
          <div
            key={active.id}
            role="tabpanel"
            id="docs-tabpanel"
            aria-labelledby={`docs-tab-${active.id}`}
            tabIndex={0}
            className="animate-tab-in"
          >
            {active.content}
          </div>
        </SelectTabContext.Provider>
      </main>
    </>
  );
}

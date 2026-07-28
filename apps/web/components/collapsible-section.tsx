"use client";

import { useState } from "react";
import type { ReactNode } from "react";

// Same faq-row visual language as components/faq-list.tsx (bare +/- marker,
// no chevron, no height transition) -- reused here for docs reference
// entries whose content is richer than a plain string (code snippets,
// terminal blocks), which is why this takes ReactNode instead of
// generalizing FaqList's own q/a string pair. One difference from
// FaqList: the trigger button is wrapped in a real <h2> (the WAI-ARIA
// accordion pattern), not a bare span -- these are genuine reference
// subsections a screen reader's "jump to heading" should still find, not
// FAQ-style quick answers.
export function CollapsibleSection({ items }: { items: { label: string; content: ReactNode }[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <div className="flex flex-col">
      {items.map((item, i) => {
        const open = openIndex === i;
        return (
          <div key={item.label} className="border-b border-border last:border-b-0">
            <h2 className="m-0">
              <button
                type="button"
                onClick={() => setOpenIndex(open ? null : i)}
                aria-expanded={open}
                className="w-full flex gap-2 py-3 text-left font-mono text-sm font-medium hover:opacity-70 transition-opacity duration-150 ease-out-strong"
              >
                <span aria-hidden="true" className="text-muted shrink-0">
                  {open ? "−" : "+"}
                </span>
                {item.label}
              </button>
            </h2>
            {open && <div className="pl-4 pb-4 flex flex-col gap-3">{item.content}</div>}
          </div>
        );
      })}
    </div>
  );
}

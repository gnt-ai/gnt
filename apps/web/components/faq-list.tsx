"use client";

import { useState } from "react";

// faq-row from the OpenCode reference doc: leads with a bare +/− marker
// indicating expand/collapse state, no chevron icon, "no animated
// accordion chrome" (its own words) -- so this stays a plain show/hide,
// no height transition. That bare +/− is also what makes this read as
// something different from the capability list above it (components/
// page.tsx's CAPABILITIES), which uses the bracketed [+] list-row marker
// and is never interactive -- same glyph family, deliberately different
// treatment per row type, matching the reference's own list-row vs
// faq-row split instead of two rows that only differ by which prop they
// were handed.
export function FaqList({ items }: { items: { q: string; a: string }[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <div className="flex flex-col">
      {items.map((item, i) => {
        const open = openIndex === i;
        return (
          <div key={item.q} className="border-b border-border last:border-b-0">
            <button
              type="button"
              onClick={() => setOpenIndex(open ? null : i)}
              aria-expanded={open}
              className="w-full flex gap-2 py-3 text-left font-mono text-sm leading-relaxed hover:opacity-70 transition-opacity duration-150 ease-out-strong"
            >
              <span aria-hidden="true" className="text-muted shrink-0">
                {open ? "−" : "+"}
              </span>
              <span className="font-bold">{item.q}</span>
            </button>
            {open && (
              <p className="pl-4 pb-3 font-mono text-sm leading-relaxed text-muted">{item.a}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

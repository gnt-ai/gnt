"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

// Same rise-and-fade docs-tabs.tsx uses for its own tab swaps
// (.animate-tab-in, globals.css) -- switching between account tabs
// (Overview/Organization/Security/Billing) is a real route change here,
// not client state, so a change of key is what Next.js needs to remount
// this wrapper and retrigger the animation, same mechanism, same visual
// language, just keyed on the URL instead of a tab id.
export function AccountContentTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="flex flex-1 flex-col animate-tab-in">
      {children}
    </div>
  );
}

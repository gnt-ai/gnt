"use client";

import { useSyncExternalStore } from "react";
import { TerminalBlock } from "@/components/terminal-block";

// The instruction has to point at *this* deployment's own
// ONBOARD_FOR_AGENTS.md -- localhost, a Vercel preview, and prod all serve
// different origins, so it can't be a hardcoded domain. window.location.origin
// doesn't exist during the server render, so this reads it the way React
// itself recommends for a value that differs between server and client:
// useSyncExternalStore with a server snapshot of null, rather than stashing
// it in state from an effect (which would cascade an extra render for a
// value that never changes after mount -- there's nothing to subscribe to).
// No fetch to confirm the doc actually exists at that URL -- if it 404s,
// that's a broken link someone can fix, not a reason to add fragile
// existence-checking logic to a page whose whole job is showing a
// copy-paste instruction.
function subscribe() {
  return () => {};
}

function getSnapshot() {
  return window.location.origin;
}

function getServerSnapshot() {
  return null;
}

export function AgentOnboardBlock() {
  const origin = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const docUrl = `${origin ?? ""}/ONBOARD_FOR_AGENTS.md`;
  const line = `${docUrl} is gnt.ai's setup guide for teams using a coding agent. Take a look and help me get gnt.ai set up for our team, checking with me for anything that needs a human.`;

  return <TerminalBlock lines={[line]} copyText={line} />;
}

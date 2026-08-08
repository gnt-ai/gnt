// PagerDuty's incident-notes response contains much more than the written
// follow-up we want to consider as decision prose. This transport-free layer
// deliberately exposes only the content of an explicitly scoped incident's
// notes; the REST endpoint and credential lifecycle stay outside this module
// until the connector contract is confirmed.

export const PAGERDUTY_WRITEUP_FIELDS = ["notes[].content"] as const;

export interface PagerDutyWriteup {
  incidentId: string;
  text: string;
}

// An explicit scope is part of the connector's privacy boundary. Preserve
// caller order for predictable provenance, but never request an incident more
// than once when a CLI value repeats it.
export function splitPagerDutyIncidentIds(raw: string | undefined): string[] {
  const seen = new Set<string>();
  for (const value of (raw ?? "").split(",")) {
    const id = value.trim();
    if (id) seen.add(id);
  }
  return [...seen];
}

// Read exactly notes[].content. In particular, do not retain a note id,
// author/responder identity, timestamps, incident severity, or timeline data
// even when a response contains them.
export function extractPagerDutyIncidentWriteups(raw: unknown, incidentId: string): PagerDutyWriteup[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as Record<string, unknown>;
  if (!Array.isArray(root.notes)) return [];

  const writeups: PagerDutyWriteup[] = [];
  for (const note of root.notes) {
    if (!note || typeof note !== "object") continue;
    const content = (note as Record<string, unknown>).content;
    if (typeof content === "string" && content.trim()) {
      writeups.push({ incidentId, text: content.trim() });
    }
  }
  return writeups;
}

import { expect, test } from "bun:test";
import {
  PAGERDUTY_WRITEUP_FIELDS,
  extractPagerDutyIncidentWriteups,
  splitPagerDutyIncidentIds,
} from "../../src/prebrain/pagerduty-postmortems.js";

test("normalizes an explicit comma-separated incident scope, dropping blanks and duplicate ids", () => {
  expect(splitPagerDutyIncidentIds(" PABC123, , PDEF456, PABC123 ")).toEqual(["PABC123", "PDEF456"]);
  expect(splitPagerDutyIncidentIds(undefined)).toEqual([]);
});

test("extracts only incident-note write-up text from a payload with sensitive incident metadata", () => {
  const raw = {
    incident: {
      id: "PABC123",
      summary: "Payments are degraded",
      urgency: "high",
      responders: [{ id: "PU123", name: "Jordan Lee", email: "jordan@example.test" }],
      timeline: [{ at: "2026-08-08T09:00:00Z", event: "Escalated to payments" }],
    },
    notes: [
      {
        id: "PNOTE1",
        content: "Root cause: the retry queue exhausted its connection pool.",
        created_at: "2026-08-08T09:30:00Z",
        user: { id: "PU123", name: "Jordan Lee", email: "jordan@example.test" },
      },
      { id: "PNOTE2", content: "", user: { name: "A second responder" } },
    ],
  };

  const writeups = extractPagerDutyIncidentWriteups(raw, "PABC123");

  expect(writeups).toEqual([
    {
      incidentId: "PABC123",
      text: "Root cause: the retry queue exhausted its connection pool.",
    },
  ]);

  const serialized = JSON.stringify(writeups);
  expect(serialized).not.toContain("Payments are degraded");
  expect(serialized).not.toContain("high");
  expect(serialized).not.toContain("Jordan Lee");
  expect(serialized).not.toContain("jordan@example.test");
  expect(serialized).not.toContain("Escalated to payments");
  expect(serialized).not.toContain("2026-08-08T09:30:00Z");
  expect(serialized).not.toContain("PNOTE1");
});

test("rejects malformed note collections without making a best-effort guess at another field", () => {
  expect(extractPagerDutyIncidentWriteups({ notes: { content: "not an array" } }, "PABC123")).toEqual([]);
  expect(extractPagerDutyIncidentWriteups({ notes: [{ body: "wrong field" }, null, "not an object"] }, "PABC123")).toEqual([]);
});

test("declares notes[].content as the only response field this scaffold may read", () => {
  expect(PAGERDUTY_WRITEUP_FIELDS).toEqual(["notes[].content"]);
});

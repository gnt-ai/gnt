// Tests the Gmail export walker end to end against a realistic small
// .mbox fixture: a three-message thread (plain text root, an HTML reply
// with a blockquote of the original, and a plain-text reply with a
// classic '>' quoted block and an "On ... wrote:" attribution line), a
// standalone message with a skipped attachment, an old message outside
// the --gmail-since range, and a message from a domain --gmail-from
// filters out. Every address is a synthetic @example.com/@example.org/
// @other-domain.com fixture, not a real one.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkGmailExport } from "../../src/prebrain/gmail-export.js";

function buildFixtureMbox(): string {
  const attachmentBase64 = Buffer.from("not a real pdf, just fixture bytes").toString("base64");

  return [
    "From alice@example.com Mon Jan 05 09:00:00 2026",
    "Message-ID: <msg1@example.com>",
    "Date: Mon, 05 Jan 2026 09:00:00 -0800",
    "From: Alice Smith <alice@example.com>",
    "To: team@example.com",
    "Subject: Refund policy for enterprise customers",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "We need to nail down our refund policy for enterprise customers.",
    "",
    "Proposal: enterprise refunds must be approved by a manager if over $5,000.",
    "",
    "From bob@example.com Mon Jan 05 10:30:00 2026",
    "Message-ID: <msg2@example.com>",
    "In-Reply-To: <msg1@example.com>",
    "References: <msg1@example.com>",
    "Date: Mon, 05 Jan 2026 10:30:00 -0800",
    "From: Bob Jones <bob@example.com>",
    "To: team@example.com",
    "Subject: Re: Refund policy for enterprise customers",
    "Content-Type: text/html; charset=UTF-8",
    "",
    "<html><body>",
    "<p>Agreed. Let's set the threshold at $5,000 and require director sign-off above $20,000.</p>",
    '<blockquote class="gmail_quote">',
    "<p>We need to nail down our refund policy for enterprise customers.</p>",
    "</blockquote>",
    "</body></html>",
    "",
    "From alice@example.com Mon Jan 05 14:00:00 2026",
    "Message-ID: <msg3@example.com>",
    "In-Reply-To: <msg2@example.com>",
    "References: <msg1@example.com> <msg2@example.com>",
    "Date: Mon, 05 Jan 2026 14:00:00 -0800",
    "From: Alice Smith <alice@example.com>",
    "To: team@example.com",
    "Subject: Re: Refund policy for enterprise customers",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Sounds good, let's lock it in.",
    "",
    "On Mon, Jan 5, 2026 at 10:30 AM, Bob Jones <bob@example.com> wrote:",
    "> Agreed. Let's set the threshold at $5,000 and require director sign-off above $20,000.",
    ">",
    "> We need to nail down our refund policy for enterprise customers.",
    "",
    "From carol@example.org Tue Jan 06 08:00:00 2026",
    "Message-ID: <msg4@example.org>",
    "Date: Tue, 06 Jan 2026 08:00:00 -0800",
    "From: Carol White <carol@example.org>",
    "To: team@example.com",
    "Subject: Signed vendor agreement",
    'Content-Type: multipart/mixed; boundary="BOUNDARY4"',
    "",
    "--BOUNDARY4",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Please see the signed agreement attached.",
    "",
    "--BOUNDARY4",
    'Content-Type: application/pdf; name="agreement.pdf"',
    'Content-Disposition: attachment; filename="agreement.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    attachmentBase64,
    "",
    "--BOUNDARY4--",
    "",
    "From dave@example.com Mon Dec 01 09:00:00 2025",
    "Message-ID: <msg5@example.com>",
    "Date: Mon, 01 Dec 2025 09:00:00 -0800",
    "From: Dave Lee <dave@example.com>",
    "To: team@example.com",
    "Subject: Old thread, do not include",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "This message predates the scoped date range and should be filtered out by --gmail-since.",
    "",
    "From newsletter@other-domain.com Wed Jan 07 09:00:00 2026",
    "Message-ID: <msg6@other-domain.com>",
    "Date: Wed, 07 Jan 2026 09:00:00 -0800",
    "From: Newsletter <newsletter@other-domain.com>",
    "To: team@example.com",
    "Subject: Weekly newsletter",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Nobody asked for this newsletter content; it should be filtered out by --gmail-from.",
    "",
  ].join("\n");
}

let workDir: string;
let mboxPath: string;

function setup() {
  workDir = mkdtempSync(join(tmpdir(), "gnt-prebrain-gmail-"));
  mboxPath = join(workDir, "All mail Including Spam and Trash.mbox");
  writeFileSync(mboxPath, buildFixtureMbox());
}

function teardown() {
  rmSync(workDir, { recursive: true, force: true });
}

test("reconstructs the three-message thread into one chunk group, tagged gmail-export", async () => {
  setup();
  try {
    const chunks = await walkGmailExport(mboxPath);
    const threadChunks = chunks.filter((c) => c.sourcePath.includes("refund-policy"));

    expect(threadChunks.length).toBeGreaterThan(0);
    for (const chunk of threadChunks) {
      expect(chunk.walker).toBe("gmail-export");
    }
    const combined = threadChunks.map((c) => c.text).join("\n");
    expect(combined).toContain("We need to nail down our refund policy");
    expect(combined).toContain("Agreed. Let's set the threshold at $5,000");
    expect(combined).toContain("Sounds good, let's lock it in.");
  } finally {
    teardown();
  }
});

test("converts the HTML reply to plain text", async () => {
  setup();
  try {
    const chunks = await walkGmailExport(mboxPath);
    const combined = chunks.map((c) => c.text).join("\n");

    expect(combined).not.toContain("<p>");
    expect(combined).not.toContain("<blockquote");
    expect(combined).toContain("Agreed. Let's set the threshold at $5,000");
  } finally {
    teardown();
  }
});

test("strips quoted history so it is not reprocessed on every reply", async () => {
  setup();
  try {
    const chunks = await walkGmailExport(mboxPath);
    const threadChunks = chunks.filter((c) => c.sourcePath.includes("refund-policy"));
    const combined = threadChunks.map((c) => c.text).join("\n");

    // Bob's reply quotes Alice's root message inside a <blockquote>; Alice's
    // second reply quotes Bob's own reply in plain '>' text. The root
    // message's own new-content line should appear exactly once across
    // the whole thread transcript, not once per reply that quoted it.
    const occurrences = combined.split("We need to nail down our refund policy").length - 1;
    expect(occurrences).toBe(1);

    // The quoted-only echo of Bob's line inside Alice's plain-text reply
    // should be gone -- only Bob's own message still carries it.
    const attributionOccurrences = combined.split("Agreed. Let's set the threshold at $5,000").length - 1;
    expect(attributionOccurrences).toBe(1);
  } finally {
    teardown();
  }
});

test("skips attachment content but keeps the filename as context, without crashing", async () => {
  setup();
  try {
    const chunks = await walkGmailExport(mboxPath);
    const attachmentChunks = chunks.filter((c) => c.sourcePath.includes("signed-vendor-agreement"));

    expect(attachmentChunks.length).toBeGreaterThan(0);
    const combined = attachmentChunks.map((c) => c.text).join("\n");
    expect(combined).toContain("Please see the signed agreement attached.");
    expect(combined).toContain("agreement.pdf");
    // The base64 attachment payload itself must never reach a chunk.
    expect(combined).not.toContain("Content-Transfer-Encoding");
    expect(combined.length).toBeLessThan(2000);
  } finally {
    teardown();
  }
});

test("--gmail-since excludes messages before the cutoff", async () => {
  setup();
  try {
    const withoutFilter = await walkGmailExport(mboxPath);
    expect(withoutFilter.some((c) => c.sourcePath.includes("old-thread"))).toBe(true);

    const withFilter = await walkGmailExport(mboxPath, { since: new Date("2026-01-01T00:00:00Z") });
    expect(withFilter.some((c) => c.sourcePath.includes("old-thread"))).toBe(false);
    // The in-range thread survives the filter.
    expect(withFilter.some((c) => c.sourcePath.includes("refund-policy"))).toBe(true);
  } finally {
    teardown();
  }
});

test("--gmail-until excludes messages after the cutoff", async () => {
  setup();
  try {
    const chunks = await walkGmailExport(mboxPath, { until: new Date("2026-01-06T23:59:59Z") });

    expect(chunks.some((c) => c.sourcePath.includes("weekly-newsletter"))).toBe(false);
    expect(chunks.some((c) => c.sourcePath.includes("signed-vendor-agreement"))).toBe(true);
  } finally {
    teardown();
  }
});

test("--gmail-from filters by sender domain", async () => {
  setup();
  try {
    const chunks = await walkGmailExport(mboxPath, { fromFilters: ["example.com"] });

    expect(chunks.some((c) => c.sourcePath.includes("weekly-newsletter"))).toBe(false);
    expect(chunks.some((c) => c.sourcePath.includes("refund-policy"))).toBe(true);
  } finally {
    teardown();
  }
});

test("--gmail-from filters by exact sender address", async () => {
  setup();
  try {
    const chunks = await walkGmailExport(mboxPath, { fromFilters: ["carol@example.org"] });
    const sourcePaths = new Set(chunks.map((c) => c.sourcePath));

    expect([...sourcePaths].every((p) => p.includes("signed-vendor-agreement"))).toBe(true);
    expect(sourcePaths.size).toBe(1);
  } finally {
    teardown();
  }
});

test("a missing mbox path produces no chunks rather than throwing", async () => {
  setup();
  try {
    const chunks = await walkGmailExport(join(workDir, "does-not-exist.mbox"));
    expect(chunks).toHaveLength(0);
  } finally {
    teardown();
  }
});

test("a path that is a directory, not a file, produces no chunks", async () => {
  setup();
  try {
    const chunks = await walkGmailExport(workDir);
    expect(chunks).toHaveLength(0);
  } finally {
    teardown();
  }
});

// Tests the Outlook export walker end to end against a realistic small
// fixture: a directory of individual .eml files forming a three-message
// thread (plain text root, an HTML reply with a blockquote of the
// original, and a plain-text reply with a classic '>' quoted block and an
// "On ... wrote:" attribution line -- the same edge cases
// gmail-export.test.ts's own mbox fixture covers, to prove
// mbox.ts's reused parseMailMessage behaves identically for standalone
// .eml input), a standalone message with a skipped attachment, an old
// message outside the --outlook-since range, and a message from a domain
// --outlook-from filters out. Two more tests cover the non-directory
// shapes --outlook also accepts: a single standalone .eml file, and a
// single mbox-shaped file (mbox.ts's existing mboxrd walker, reused
// as-is). Every address is a synthetic @example.com/@example.org/
// @other-domain.com fixture, not a real one.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkOutlookExport } from "../../src/prebrain/outlook-export.js";

// mbox.ts's header/body split and line-folding logic (shared unchanged by
// this walker) works on "\n"-delimited lines, the same convention every
// mbox.ts/gmail-export.ts fixture already uses -- not CRLF, which would
// leave a stray "\r" between the two newlines splitHeadersBody looks for
// and break the header/body split entirely. Real .eml files on disk are
// commonly CRLF; this is a documented pre-existing gap in mbox.ts's
// parsing, not something this walker's own fixtures should paper over.
function eml(lines: string[]): string {
  return lines.join("\n");
}

function buildFixtureDir(dir: string) {
  const attachmentBase64 = Buffer.from("not a real pdf, just fixture bytes").toString("base64");

  writeFileSync(
    join(dir, "root.eml"),
    eml([
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
    ]),
  );

  writeFileSync(
    join(dir, "reply-html.eml"),
    eml([
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
    ]),
  );

  writeFileSync(
    join(dir, "reply-plain.eml"),
    eml([
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
    ]),
  );

  writeFileSync(
    join(dir, "vendor-agreement.eml"),
    eml([
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
    ]),
  );

  writeFileSync(
    join(dir, "old-thread.eml"),
    eml([
      "Message-ID: <msg5@example.com>",
      "Date: Mon, 01 Dec 2025 09:00:00 -0800",
      "From: Dave Lee <dave@example.com>",
      "To: team@example.com",
      "Subject: Old thread, do not include",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "This message predates the scoped date range and should be filtered out by --outlook-since.",
    ]),
  );

  writeFileSync(
    join(dir, "newsletter.eml"),
    eml([
      "Message-ID: <msg6@other-domain.com>",
      "Date: Wed, 07 Jan 2026 09:00:00 -0800",
      "From: Newsletter <newsletter@other-domain.com>",
      "To: team@example.com",
      "Subject: Weekly newsletter",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Nobody asked for this newsletter content; it should be filtered out by --outlook-from.",
    ]),
  );
}

let workDir: string;
let emlDir: string;

function setup() {
  workDir = mkdtempSync(join(tmpdir(), "gnt-prebrain-outlook-"));
  emlDir = join(workDir, "eml-export");
  mkdirSync(emlDir, { recursive: true });
  buildFixtureDir(emlDir);
}

function teardown() {
  rmSync(workDir, { recursive: true, force: true });
}

test("reconstructs the three-message thread from a directory of .eml files into one chunk group, tagged outlook-export", async () => {
  setup();
  try {
    const chunks = await walkOutlookExport(emlDir);
    const threadChunks = chunks.filter((c) => c.sourcePath.includes("refund-policy"));

    expect(threadChunks.length).toBeGreaterThan(0);
    for (const chunk of threadChunks) {
      expect(chunk.walker).toBe("outlook-export");
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
    const chunks = await walkOutlookExport(emlDir);
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
    const chunks = await walkOutlookExport(emlDir);
    const threadChunks = chunks.filter((c) => c.sourcePath.includes("refund-policy"));
    const combined = threadChunks.map((c) => c.text).join("\n");

    const occurrences = combined.split("We need to nail down our refund policy").length - 1;
    expect(occurrences).toBe(1);

    const attributionOccurrences = combined.split("Agreed. Let's set the threshold at $5,000").length - 1;
    expect(attributionOccurrences).toBe(1);
  } finally {
    teardown();
  }
});

test("skips attachment content but keeps the filename as context, without crashing", async () => {
  setup();
  try {
    const chunks = await walkOutlookExport(emlDir);
    const attachmentChunks = chunks.filter((c) => c.sourcePath.includes("signed-vendor-agreement"));

    expect(attachmentChunks.length).toBeGreaterThan(0);
    const combined = attachmentChunks.map((c) => c.text).join("\n");
    expect(combined).toContain("Please see the signed agreement attached.");
    expect(combined).toContain("agreement.pdf");
    expect(combined).not.toContain("Content-Transfer-Encoding");
    expect(combined.length).toBeLessThan(2000);
  } finally {
    teardown();
  }
});

test("--outlook-since excludes messages before the cutoff", async () => {
  setup();
  try {
    const withoutFilter = await walkOutlookExport(emlDir);
    expect(withoutFilter.some((c) => c.sourcePath.includes("old-thread"))).toBe(true);

    const withFilter = await walkOutlookExport(emlDir, { since: new Date("2026-01-01T00:00:00Z") });
    expect(withFilter.some((c) => c.sourcePath.includes("old-thread"))).toBe(false);
    expect(withFilter.some((c) => c.sourcePath.includes("refund-policy"))).toBe(true);
  } finally {
    teardown();
  }
});

test("--outlook-until excludes messages after the cutoff", async () => {
  setup();
  try {
    const chunks = await walkOutlookExport(emlDir, { until: new Date("2026-01-06T23:59:59Z") });

    expect(chunks.some((c) => c.sourcePath.includes("weekly-newsletter"))).toBe(false);
    expect(chunks.some((c) => c.sourcePath.includes("signed-vendor-agreement"))).toBe(true);
  } finally {
    teardown();
  }
});

test("--outlook-from filters by sender domain", async () => {
  setup();
  try {
    const chunks = await walkOutlookExport(emlDir, { fromFilters: ["example.com"] });

    expect(chunks.some((c) => c.sourcePath.includes("weekly-newsletter"))).toBe(false);
    expect(chunks.some((c) => c.sourcePath.includes("refund-policy"))).toBe(true);
  } finally {
    teardown();
  }
});

test("--outlook-from filters by exact sender address", async () => {
  setup();
  try {
    const chunks = await walkOutlookExport(emlDir, { fromFilters: ["carol@example.org"] });
    const sourcePaths = new Set(chunks.map((c) => c.sourcePath));

    expect([...sourcePaths].every((p) => p.includes("signed-vendor-agreement"))).toBe(true);
    expect(sourcePaths.size).toBe(1);
  } finally {
    teardown();
  }
});

test("a missing path produces no chunks rather than throwing", async () => {
  setup();
  try {
    const chunks = await walkOutlookExport(join(workDir, "does-not-exist"));
    expect(chunks).toHaveLength(0);
  } finally {
    teardown();
  }
});

test("a single standalone .eml file (not a directory) is parsed as one message", async () => {
  setup();
  try {
    const singlePath = join(workDir, "single-message.eml");
    writeFileSync(
      singlePath,
      eml([
        "Message-ID: <solo@example.com>",
        "Date: Thu, 08 Jan 2026 09:00:00 -0800",
        "From: Erin Park <erin@example.com>",
        "To: team@example.com",
        "Subject: One-off decision, not part of a thread",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        "New vendors must be added to the approved list before any PO is cut.",
      ]),
    );

    const chunks = await walkOutlookExport(singlePath);

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(chunk.walker).toBe("outlook-export");
    const combined = chunks.map((c) => c.text).join("\n");
    expect(combined).toContain("New vendors must be added to the approved list");
  } finally {
    teardown();
  }
});

test("parses a CRLF-terminated .eml file (the real line ending RFC 5322 -- and Outlook's own exports -- use), not just LF fixtures", async () => {
  setup();
  try {
    const crlfPath = join(workDir, "crlf-message.eml");
    const raw = [
      "Message-ID: <crlf@example.com>",
      "Date: Fri, 09 Jan 2026 09:00:00 -0800",
      "From: Frank Osei <frank@example.com>",
      "To: team@example.com",
      "Subject: Sent from real Outlook, CRLF line endings",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "All vendor contracts over $10,000 require legal review before signature.",
    ].join("\r\n");
    writeFileSync(crlfPath, raw);

    const chunks = await walkOutlookExport(crlfPath);

    expect(chunks.length).toBeGreaterThan(0);
    const combined = chunks.map((c) => c.text).join("\n");
    expect(combined).toContain("All vendor contracts over $10,000 require legal review");
  } finally {
    teardown();
  }
});

test("a single mbox-shaped file is sniffed and parsed with mbox.ts's own mboxrd walker, not as one .eml message", async () => {
  setup();
  try {
    const mboxPath = join(workDir, "bridged-export.mbox");
    writeFileSync(
      mboxPath,
      [
        "From alice@example.com Mon Jan 05 09:00:00 2026",
        "Message-ID: <bridged-1@example.com>",
        "Date: Mon, 05 Jan 2026 09:00:00 -0800",
        "From: Alice Smith <alice@example.com>",
        "Subject: Bridged mailbox message one",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        "First bridged message body.",
        "",
        "From bob@example.com Mon Jan 05 10:00:00 2026",
        "Message-ID: <bridged-2@example.com>",
        "Date: Mon, 05 Jan 2026 10:00:00 -0800",
        "From: Bob Jones <bob@example.com>",
        "Subject: Bridged mailbox message two",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        "Second bridged message body.",
        "",
      ].join("\n"),
    );

    const chunks = await walkOutlookExport(mboxPath);

    expect(chunks.length).toBe(2);
    for (const chunk of chunks) expect(chunk.walker).toBe("outlook-export");
    const combined = chunks.map((c) => c.text).join("\n");
    expect(combined).toContain("First bridged message body.");
    expect(combined).toContain("Second bridged message body.");
  } finally {
    teardown();
  }
});

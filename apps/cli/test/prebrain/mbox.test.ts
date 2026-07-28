// Unit tests for mbox.ts: mboxrd splitting/unescaping, RFC 5322 header
// folding, MIME multipart walking, quoted-printable/base64/RFC 2047
// decoding, and attachment detection. gmail-export.test.ts covers the
// walker end-to-end against a realistic multi-message fixture; this file
// isolates the parsing primitives it depends on.
import { expect, test } from "bun:test";
import { parseMailMessage, splitMboxMessages } from "../../src/prebrain/mbox.js";

test("splits an mbox file into individual messages on 'From ' boundary lines", () => {
  const raw = [
    "From alice@example.com Mon Jan 05 09:00:00 2026",
    "Subject: First",
    "",
    "Body one.",
    "",
    "From bob@example.com Mon Jan 05 10:00:00 2026",
    "Subject: Second",
    "",
    "Body two.",
    "",
  ].join("\n");

  const messages = splitMboxMessages(raw);

  expect(messages).toHaveLength(2);
  expect(messages[0]).toContain("Subject: First");
  expect(messages[0]).toContain("Body one.");
  expect(messages[1]).toContain("Subject: Second");
  expect(messages[1]).toContain("Body two.");
});

test("unescapes mboxrd-quoted 'From ' lines inside a message body", () => {
  const raw = [
    "From alice@example.com Mon Jan 05 09:00:00 2026",
    "Subject: Quoting test",
    "",
    "Someone wrote:",
    ">From the report: revenue is up.",
    "",
  ].join("\n");

  const messages = splitMboxMessages(raw);

  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("From the report: revenue is up.");
  expect(messages[0]).not.toContain(">From the report");
});

test("parses headers, including folded continuation lines", () => {
  const raw = [
    "Message-ID: <abc@example.com>",
    "Subject: A subject line that got",
    " folded across two physical lines",
    "From: Alice <alice@example.com>",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Body text.",
  ].join("\n");

  const msg = parseMailMessage(raw);

  expect(msg.messageId).toBe("abc@example.com");
  expect(msg.subject).toBe("A subject line that got folded across two physical lines");
  expect(msg.bodyText).toBe("Body text.");
});

test("parses Message-ID/In-Reply-To/References for thread reconstruction", () => {
  const raw = [
    "Message-ID: <reply@example.com>",
    "In-Reply-To: <root@example.com>",
    "References: <root@example.com> <middle@example.com>",
    "From: bob@example.com",
    "Content-Type: text/plain",
    "",
    "A reply.",
  ].join("\n");

  const msg = parseMailMessage(raw);

  expect(msg.messageId).toBe("reply@example.com");
  expect(msg.inReplyTo).toBe("root@example.com");
  expect(msg.references).toEqual(["root@example.com", "middle@example.com"]);
});

test("decodes RFC 2047 encoded-word subjects and display names", () => {
  const encodedSubject = Buffer.from("Resumé", "utf-8").toString("base64");
  const raw = [
    "Message-ID: <x@example.com>",
    `Subject: =?UTF-8?B?${encodedSubject}?=`,
    "From: =?UTF-8?Q?Ren=C3=A9e?= <renee@example.com>",
    "Content-Type: text/plain",
    "",
    "Body.",
  ].join("\n");

  const msg = parseMailMessage(raw);

  expect(msg.subject).toBe("Resumé");
  expect(msg.from).toBe("Renée <renee@example.com>");
  expect(msg.fromAddress).toBe("renee@example.com");
});

test("decodes a quoted-printable body", () => {
  const raw = [
    "Message-ID: <qp@example.com>",
    "From: alice@example.com",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Caf=C3=A9 con leche, please.=",
    "Continued on the next line.",
  ].join("\n");

  const msg = parseMailMessage(raw);

  expect(msg.bodyText).toBe("Café con leche, please.Continued on the next line.");
});

test("decodes a base64 body", () => {
  const encoded = Buffer.from("Base64-encoded body content.").toString("base64");
  const raw = [
    "Message-ID: <b64@example.com>",
    "From: alice@example.com",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    encoded,
  ].join("\n");

  const msg = parseMailMessage(raw);

  expect(msg.bodyText).toBe("Base64-encoded body content.");
});

test("prefers the text/plain branch of a multipart/alternative body over html", () => {
  const raw = [
    "Message-ID: <alt@example.com>",
    "From: alice@example.com",
    'Content-Type: multipart/alternative; boundary="B1"',
    "",
    "--B1",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Plain text version.",
    "",
    "--B1",
    "Content-Type: text/html; charset=UTF-8",
    "",
    "<p>HTML version.</p>",
    "",
    "--B1--",
    "",
  ].join("\n");

  const msg = parseMailMessage(raw);

  expect(msg.bodyText).toBe("Plain text version.");
});

test("converts an html-only body to text when there is no plain-text alternative", () => {
  const raw = [
    "Message-ID: <html-only@example.com>",
    "From: alice@example.com",
    "Content-Type: text/html; charset=UTF-8",
    "",
    "<p>Only HTML here.</p>",
  ].join("\n");

  const msg = parseMailMessage(raw);

  expect(msg.bodyText).toBe("Only HTML here.");
});

test("skips attachment content but records the filename and attachment flag", () => {
  const attachmentBytes = Buffer.from("not real pdf bytes, just a fixture").toString("base64");
  const raw = [
    "Message-ID: <att@example.com>",
    "From: alice@example.com",
    'Content-Type: multipart/mixed; boundary="B2"',
    "",
    "--B2",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "See the attached file.",
    "",
    "--B2",
    'Content-Type: application/pdf; name="notes.pdf"',
    'Content-Disposition: attachment; filename="notes.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    attachmentBytes,
    "",
    "--B2--",
    "",
  ].join("\n");

  const msg = parseMailMessage(raw);

  expect(msg.bodyText).toBe("See the attached file.");
  expect(msg.hasAttachments).toBe(true);
  expect(msg.attachmentNames).toEqual(["notes.pdf"]);
  expect(msg.bodyText).not.toContain(attachmentBytes);
});

test("treats an inline non-text part with no Content-Disposition or filename as skippable, not as text", () => {
  // Rare in practice (most real mail marks this explicitly), but a part
  // like this should never have its raw binary bytes force-decoded as
  // text and land in a chunk.
  const raw = [
    "Message-ID: <inline-binary@example.com>",
    "From: alice@example.com",
    'Content-Type: multipart/mixed; boundary="B3"',
    "",
    "--B3",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "See the inline image below.",
    "",
    "--B3",
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
    "",
    "--B3--",
    "",
  ].join("\n");

  const msg = parseMailMessage(raw);

  expect(msg.bodyText).toBe("See the inline image below.");
});

test("a message with no headers at all still returns a best-effort result rather than throwing", () => {
  expect(() => parseMailMessage("just some text with no headers")).not.toThrow();
});

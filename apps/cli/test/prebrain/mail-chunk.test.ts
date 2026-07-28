// Unit tests for mail-chunk.ts's thread reconstruction, quote-stripping,
// and chunk-sizing logic in isolation from mbox parsing (gmail-export.test.ts
// covers the two together end to end).
import { expect, test } from "bun:test";
import { buildThreads, chunkMailThreads, stripQuotedContent, threadToChunks } from "../../src/prebrain/mail-chunk.js";
import type { ParsedMailMessage } from "../../src/prebrain/mbox.js";

function makeMessage(overrides: Partial<ParsedMailMessage>): ParsedMailMessage {
  return {
    messageId: null,
    inReplyTo: null,
    references: [],
    from: "Alice <alice@example.com>",
    fromAddress: "alice@example.com",
    to: "team@example.com",
    subject: "Test subject",
    date: new Date("2026-01-05T09:00:00Z"),
    bodyText: "Body.",
    attachmentNames: [],
    hasAttachments: false,
    ...overrides,
  };
}

test("groups messages linked by In-Reply-To into one thread", () => {
  const root = makeMessage({ messageId: "root@example.com", subject: "Refund policy" });
  const reply = makeMessage({
    messageId: "reply@example.com",
    inReplyTo: "root@example.com",
    subject: "Re: Refund policy",
    date: new Date("2026-01-05T10:00:00Z"),
  });

  const threads = buildThreads([reply, root]); // deliberately out of order -- sorting is threadToChunks's/buildThreads's own job

  expect(threads).toHaveLength(1);
  expect(threads[0].messages.map((m) => m.messageId)).toEqual(["root@example.com", "reply@example.com"]);
});

test("groups messages linked only by References, when In-Reply-To is missing", () => {
  const root = makeMessage({ messageId: "root@example.com" });
  const reply = makeMessage({
    messageId: "reply@example.com",
    references: ["root@example.com"],
  });

  const threads = buildThreads([root, reply]);

  expect(threads).toHaveLength(1);
});

test("keeps unrelated messages as separate single-message threads", () => {
  const a = makeMessage({ messageId: "a@example.com", subject: "First topic" });
  const b = makeMessage({ messageId: "b@example.com", subject: "Second topic" });

  const threads = buildThreads([a, b]);

  expect(threads).toHaveLength(2);
});

test("a message with no Message-ID still becomes its own thread instead of being dropped", () => {
  const noId = makeMessage({ messageId: null, subject: "No id" });

  const threads = buildThreads([noId]);

  expect(threads).toHaveLength(1);
  expect(threads[0].messages).toHaveLength(1);
});

test("a reference to a message outside the input set is ignored, not an error", () => {
  const msg = makeMessage({ messageId: "reply@example.com", inReplyTo: "not-in-this-run@example.com" });

  const threads = buildThreads([msg]);

  expect(threads).toHaveLength(1);
});

test("strips a plain-text '>' quoted block, keeping the reply's own new content", () => {
  const body = ["New content up top.", "", "> Old quoted line one.", "> Old quoted line two."].join("\n");
  expect(stripQuotedContent(body)).toBe("New content up top.");
});

test("strips everything from an 'On ... wrote:' attribution line onward", () => {
  const body = [
    "Sounds good.",
    "",
    "On Mon, Jan 5, 2026 at 10:30 AM, Bob <bob@example.com> wrote:",
    "> Earlier message content.",
  ].join("\n");
  expect(stripQuotedContent(body)).toBe("Sounds good.");
});

test("leaves a message with no quoted content untouched", () => {
  const body = "Just new content, no quoting at all.";
  expect(stripQuotedContent(body)).toBe(body);
});

test("chunks a thread into review-sized chunks tagged with the given walker", () => {
  const root = makeMessage({ messageId: "root@example.com", subject: "Escalation policy", bodyText: "Root content." });
  const reply = makeMessage({
    messageId: "reply@example.com",
    inReplyTo: "root@example.com",
    subject: "Re: Escalation policy",
    bodyText: "Reply content.",
    date: new Date("2026-01-05T10:00:00Z"),
  });

  const chunks = threadToChunks({ messages: [root, reply] }, "gmail-export");

  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.walker).toBe("gmail-export");
    expect(chunk.sourcePath).toMatch(/^threads\/escalation-policy-/);
  }
  const combined = chunks.map((c) => c.text).join("\n");
  expect(combined).toContain("Root content.");
  expect(combined).toContain("Reply content.");
});

test("chunkMailThreads reconstructs threads and chunks them in one call", () => {
  const root = makeMessage({ messageId: "root@example.com", subject: "Topic" });
  const reply = makeMessage({ messageId: "reply@example.com", inReplyTo: "root@example.com", subject: "Re: Topic" });
  const unrelated = makeMessage({ messageId: "other@example.com", subject: "Unrelated topic" });

  const chunks = chunkMailThreads([root, reply, unrelated], "gmail-export");
  const sourcePaths = new Set(chunks.map((c) => c.sourcePath));

  expect(sourcePaths.size).toBe(2); // one path for the root+reply thread, one for the unrelated message
});

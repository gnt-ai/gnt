// Tests for the shared transcript chunker. These
// are independent of any adapter -- Granola, Zoom, and the meeting-
// export walkers all depend on this module's correctness, so it
// gets its own test file rather than being checked only indirectly through
// mcp-granola.test.ts.
import { expect, test } from "bun:test";
import { chunkTranscript, parseSpeakerTurns } from "../../src/prebrain/transcript-chunk.js";

test("parses header-with-timestamp turns, one per speaker block", () => {
  const content = ["Jane Doe  00:14:32", "This is what Jane said.", "", "John Smith  00:15:01", "This is what John said."].join(
    "\n",
  );

  const turns = parseSpeakerTurns(content);

  expect(turns).toHaveLength(2);
  expect(turns[0]).toMatchObject({ speaker: "Jane Doe", text: "This is what Jane said." });
  expect(turns[1]).toMatchObject({ speaker: "John Smith", text: "This is what John said." });
});

test("parses bare-colon header turns", () => {
  const content = ["Jane Doe:", "Multi-line text", "still Jane's turn.", "", "John Smith:", "John's reply."].join("\n");

  const turns = parseSpeakerTurns(content);

  expect(turns).toHaveLength(2);
  expect(turns[0]).toMatchObject({ speaker: "Jane Doe", text: "Multi-line text\nstill Jane's turn." });
  expect(turns[1]).toMatchObject({ speaker: "John Smith", text: "John's reply." });
});

test("parses inline 'Name: text' turns on a single line", () => {
  const content = ["Jane Doe: Let's go with option B.", "", "John Smith: Agreed, option B it is."].join("\n");

  const turns = parseSpeakerTurns(content);

  expect(turns).toHaveLength(2);
  expect(turns[0]).toMatchObject({ speaker: "Jane Doe", text: "Let's go with option B." });
  expect(turns[1]).toMatchObject({ speaker: "John Smith", text: "Agreed, option B it is." });
});

test("a block with no detected speaker header continues the previous speaker's turn", () => {
  const content = ["Jane Doe:", "First part of Jane's turn.", "", "Still Jane's turn, exported across a blank line."].join(
    "\n",
  );

  const turns = parseSpeakerTurns(content);

  expect(turns).toHaveLength(1);
  expect(turns[0].speaker).toBe("Jane Doe");
  expect(turns[0].text).toBe("First part of Jane's turn.\nStill Jane's turn, exported across a blank line.");
});

test("plain prose with no speaker markup at all degrades to unattributed turns, one per paragraph", () => {
  const content = ["First paragraph of plain notes.", "", "Second paragraph of plain notes."].join("\n");

  const turns = parseSpeakerTurns(content);

  expect(turns).toHaveLength(2);
  expect(turns[0]).toMatchObject({ speaker: null, text: "First paragraph of plain notes." });
  expect(turns[1]).toMatchObject({ speaker: null, text: "Second paragraph of plain notes." });
});

test("a markdown heading never merges into a surrounding turn", () => {
  const content = ["# Meeting notes", "", "Jane Doe: some dialogue.", "", "## Notes", "", "A notes paragraph."].join("\n");

  const turns = parseSpeakerTurns(content);

  expect(turns.map((t) => t.text)).toEqual(["# Meeting notes", "some dialogue.", "## Notes", "A notes paragraph."]);
  expect(turns[0].speaker).toBeNull();
  expect(turns[2].speaker).toBeNull();
});

test("chunkTranscript never splits a single turn across chunks", () => {
  const longTurn = "Jane Doe: " + "This must never be cut mid-sentence. ".repeat(20);
  const content = [longTurn.trim(), "", "John Smith: A short reply."].join("\n");

  const chunks = chunkTranscript(content, 100);

  // The oversized turn is its own chunk, whole, same as chunkText's own
  // "never split mid-paragraph" guarantee.
  expect(chunks[0].text).toContain("Jane Doe: This must never be cut mid-sentence.");
  expect(chunks[0].text.startsWith("Jane Doe:")).toBe(true);
  expect(chunks[0].text.endsWith("Jane Doe: A short reply.")).toBe(false);
});

test("groups small turns under the cap into one chunk, in speaker order", () => {
  const content = ["Jane Doe: Morning.", "", "John Smith: Morning, how was your weekend?", "", "Jane Doe: Good, thanks."].join(
    "\n",
  );

  const chunks = chunkTranscript(content, 1000);

  expect(chunks).toHaveLength(1);
  expect(chunks[0].text).toBe(
    "Jane Doe: Morning.\n\nJohn Smith: Morning, how was your weekend?\n\nJane Doe: Good, thanks.",
  );
});

test("splits at the ordinary cap once no decision language is involved", () => {
  const turnA = "Jane Doe: " + "a".repeat(60);
  const turnB = "John Smith: " + "b".repeat(60);
  const turnC = "Jane Doe: " + "c".repeat(60);
  const content = [turnA, "", turnB, "", turnC].join("\n");

  const chunks = chunkTranscript(content, 90);

  expect(chunks).toHaveLength(3);
});

test("extends the cap to keep a decision statement and its immediate reply together", () => {
  const decisionLine = "Jane Doe: We're going to go with the vendor migration in Q3.";
  const replyLine = "John Smith: Sounds good, I'll update the roadmap doc to reflect that.";
  const content = [decisionLine, "", replyLine].join("\n");

  const total = decisionLine.length + 2 + (replyLine.length + 2);
  // Strictly between total/1.5 and total: too small for both turns under
  // the ordinary cap, but the extended (1.5x) cap covers them.
  const cap = Math.ceil(total / 1.3);

  const chunks = chunkTranscript(content, cap);

  expect(chunks).toHaveLength(1);
  expect(chunks[0].text).toContain("We're going to go with the vendor migration in Q3.");
  expect(chunks[0].text).toContain("I'll update the roadmap doc to reflect that.");
});

test("closes a chunk right after a decision moment resolves, ahead of the size cap, once unrelated small talk resumes", () => {
  const content = [
    "Jane Doe: We're going to go with option B for the launch, since it gives us the most " +
      "flexibility on rollout timing and lets marketing coordinate their own announcement " +
      "independently of engineering's release schedule.",
    "",
    "John Smith: Great, that makes sense to me, I'll get the roadmap doc updated today and loop " +
      "in the design team on what this means for the onboarding flow timeline.",
    "",
    "Alex Chen: Anyway, did anyone catch the game last night?",
    "",
    "Jane Doe: Not this time, was heads down all week.",
  ].join("\n");

  // A large cap -- the whole transcript fits comfortably, so any split
  // here comes from the decision-moment heuristic, not the byte count.
  const chunks = chunkTranscript(content, 5000);

  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[0].text).toContain("We're going to go with option B for the launch");
  expect(chunks[0].text).toContain("I'll get the roadmap doc updated today");
  expect(chunks[0].text).not.toContain("did anyone catch the game");
  expect(chunks[1].text).toContain("did anyone catch the game");
});

test("does not early-close a decision-moment chunk that is still trivially small", () => {
  const content = ["Jane Doe: We must ship this.", "", "John Smith: ok.", "", "Alex Chen: Cool."].join("\n");

  const chunks = chunkTranscript(content, 5000);

  // Well under MIN_CHARS_BEFORE_EARLY_CLOSE -- stays one chunk rather than
  // fragmenting a two-word exchange.
  expect(chunks).toHaveLength(1);
});

test("empty content produces no chunks", () => {
  expect(chunkTranscript("")).toHaveLength(0);
  expect(chunkTranscript("\n\n\n")).toHaveLength(0);
});

test("chunk line spans are 1-indexed and cover the turns they contain", () => {
  const content = ["Jane Doe: Line two.", "", "John Smith: Line four."].join("\n");

  const chunks = chunkTranscript(content, 1000);

  expect(chunks).toHaveLength(1);
  expect(chunks[0].startLine).toBe(1);
  expect(chunks[0].endLine).toBe(3);
});

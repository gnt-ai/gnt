// Tests the meeting-notes export walker against
// realistic VTT, SRT, and plain-text fixtures. This file's own job is
// parsing -- VTT/SRT cue merging and plain-text bracket/paren-timestamp
// normalization -- not re-testing the shared transcript chunker's own
// turn-boundary/decision-moment behavior, which transcript-chunk.test.ts
// already covers in depth. Where a test below does check that decision-
// moment chunking still fires, it's proving this walker's parsed output is
// well-formed chunker input (same content shape transcript-chunk.test.ts's
// own fixtures use), not re-deriving the heuristic's own correctness.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkTranscript, parseSpeakerTurns } from "../../src/prebrain/transcript-chunk.js";
import {
  parseCueTranscript,
  parsePlainTextTranscript,
  walkMeetingNotesExport,
} from "../../src/prebrain/meeting-notes-export.js";

// -- VTT cue parsing --

test("merges consecutive same-speaker VTT cues into one turn, joined with a space", () => {
  const vtt = [
    "WEBVTT",
    "",
    "1",
    "00:00:00.000 --> 00:00:04.000",
    "<v Jane Doe>We're going to go with option B for the launch,",
    "",
    "2",
    "00:00:04.000 --> 00:00:07.500",
    "<v Jane Doe>since it gives us the most flexibility on rollout timing.",
    "",
    "3",
    "00:00:07.500 --> 00:00:11.000",
    "<v John Smith>Great, that makes sense to me.",
  ].join("\n");

  const turns = parseSpeakerTurns(parseCueTranscript(vtt));

  expect(turns).toHaveLength(2);
  expect(turns[0]).toMatchObject({
    speaker: "Jane Doe",
    text: "We're going to go with option B for the launch, since it gives us the most flexibility on rollout timing.",
  });
  expect(turns[1]).toMatchObject({ speaker: "John Smith", text: "Great, that makes sense to me." });
});

test("a VTT cue with no <v> tag or inline speaker continues the previous cue's speaker", () => {
  const vtt = [
    "WEBVTT",
    "",
    "1",
    "00:00:00.000 --> 00:00:03.000",
    "<v John Smith>I'll update the roadmap doc today.",
    "",
    "2",
    "00:00:03.000 --> 00:00:05.000",
    "(crosstalk)",
    "",
    "3",
    "00:00:05.000 --> 00:00:08.000",
    "<v Alex Chen>Anyway, did anyone catch the game last night?",
  ].join("\n");

  const turns = parseSpeakerTurns(parseCueTranscript(vtt));

  expect(turns).toHaveLength(2);
  expect(turns[0].speaker).toBe("John Smith");
  expect(turns[0].text).toContain("I'll update the roadmap doc today.");
  expect(turns[0].text).toContain("(crosstalk)");
  expect(turns[1]).toMatchObject({ speaker: "Alex Chen", text: "Anyway, did anyone catch the game last night?" });
});

test("VTT NOTE blocks and the WEBVTT header itself are skipped, not misread as cue text", () => {
  const vtt = [
    "WEBVTT",
    "",
    "NOTE",
    "This transcript was auto-generated.",
    "",
    "1",
    "00:00:00.000 --> 00:00:03.000",
    "<v Jane Doe>Let's go with option B.",
  ].join("\n");

  const turns = parseSpeakerTurns(parseCueTranscript(vtt));

  expect(turns).toHaveLength(1);
  expect(turns[0].text).not.toContain("auto-generated");
  expect(turns[0].text).not.toContain("NOTE");
});

test("strips other inline VTT markup (styling tags, karaoke timing tags) from cue text", () => {
  const vtt = [
    "WEBVTT",
    "",
    "1",
    "00:00:00.000 --> 00:00:03.000",
    "<v Jane Doe><b>We've decided</b> to <00:00:01.000>push the launch.",
  ].join("\n");

  const turns = parseSpeakerTurns(parseCueTranscript(vtt));

  expect(turns).toHaveLength(1);
  expect(turns[0].text).toBe("We've decided to push the launch.");
});

test("a fully speaker-less cue file (captions with speaker labels turned off) does not collapse into one giant turn", () => {
  // No <v> tags and no inline "Name:" convention anywhere -- the shape a
  // real Otter/Fireflies export has when the speaker-label toggle is off.
  // Unattributed cues must NOT all merge into a single turn (that turn
  // would then be atomic all the way through chunkTranscript, which never
  // splits a turn once formed, producing one oversized chunk for the
  // entire file) -- each stays its own turn, and the shared chunker's own
  // size cap is what groups them into normal, cap-respecting chunks.
  const vtt = [
    "WEBVTT",
    "",
    "1",
    "00:00:00.000 --> 00:00:04.000",
    "First unattributed caption line.",
    "",
    "2",
    "00:00:04.000 --> 00:00:08.000",
    "Second unattributed caption line.",
    "",
    "3",
    "00:00:08.000 --> 00:00:12.000",
    "Third unattributed caption line.",
  ].join("\n");

  const turns = parseSpeakerTurns(parseCueTranscript(vtt));

  expect(turns).toHaveLength(3);
  expect(turns.every((t) => t.speaker === null)).toBe(true);

  // With a small cap, the shared chunker still splits this across more
  // than one chunk -- proof it never became one unsplittable turn.
  const chunks = chunkTranscript(parseCueTranscript(vtt), 60);
  expect(chunks.length).toBeGreaterThan(1);
});

// -- SRT cue parsing (same cue parser as VTT; see this walker's own doc
// comment for why Otter/Fireflies' real current export is SRT, not VTT) --

test("parses an SRT file (comma decimal separator, numeric index, no WEBVTT header, inline 'Name: text' speaker convention)", () => {
  const srt = [
    "1",
    "00:00:00,000 --> 00:00:03,000",
    "Jane Doe: We've decided to push the launch to next quarter.",
    "",
    "2",
    "00:00:03,000 --> 00:00:06,000",
    "John Smith: Sounds good, I'll let the team know.",
  ].join("\n");

  const turns = parseSpeakerTurns(parseCueTranscript(srt));

  expect(turns).toHaveLength(2);
  expect(turns[0]).toMatchObject({ speaker: "Jane Doe", text: "We've decided to push the launch to next quarter." });
  expect(turns[1]).toMatchObject({ speaker: "John Smith", text: "Sounds good, I'll let the team know." });
});

// -- Plain-text parsing --

test("Otter-style 'Speaker Name  timestamp' header lines pass through unchanged (already read by transcript-chunk.ts)", () => {
  const text = ["Jane Doe  0:00", "This is what Jane said.", "", "John Smith  0:14", "This is what John said."].join(
    "\n",
  );

  const turns = parseSpeakerTurns(parsePlainTextTranscript(text));

  expect(turns).toHaveLength(2);
  expect(turns[0]).toMatchObject({ speaker: "Jane Doe", text: "This is what Jane said." });
  expect(turns[1]).toMatchObject({ speaker: "John Smith", text: "This is what John said." });
});

test("strips a leading bracket timestamp from a Fireflies-style '[HH:MM:SS] Name: text' line", () => {
  const text = [
    "[00:00:10] Ross: Today, we will discuss the impact of adding transcriptions.",
    "",
    "[00:00:22] Monica: Agreed, that's a great topic.",
  ].join("\n");

  const turns = parseSpeakerTurns(parsePlainTextTranscript(text));

  expect(turns).toHaveLength(2);
  expect(turns[0]).toMatchObject({
    speaker: "Ross",
    text: "Today, we will discuss the impact of adding transcriptions.",
  });
  expect(turns[1]).toMatchObject({ speaker: "Monica", text: "Agreed, that's a great topic." });
});

test("strips a trailing paren or bracket timestamp between a name and its colon", () => {
  const text = [
    "Alice Johnson (00:05:32): Let's revisit the budget allocations.",
    "",
    "Bob Lee [00:05:48]: Sure, pulling that up now.",
  ].join("\n");

  const turns = parseSpeakerTurns(parsePlainTextTranscript(text));

  expect(turns).toHaveLength(2);
  expect(turns[0]).toMatchObject({ speaker: "Alice Johnson", text: "Let's revisit the budget allocations." });
  expect(turns[1]).toMatchObject({ speaker: "Bob Lee", text: "Sure, pulling that up now." });
});

test("plain text with no timestamp markup at all is left untouched", () => {
  const text = ["Jane Doe: Let's go with option B.", "", "John Smith: Agreed."].join("\n");

  expect(parsePlainTextTranscript(text)).toBe(text);
});

// -- End-to-end: parsed output flows into the shared chunker correctly --

test("the decision-moment heuristic still fires on a VTT-sourced document, same as it does for plain markdown input", () => {
  const vtt = [
    "WEBVTT",
    "",
    "1",
    "00:00:00.000 --> 00:00:06.000",
    "<v Jane Doe>We're going to go with option B for the launch, since it gives us the most " +
      "flexibility on rollout timing and lets marketing coordinate their own announcement " +
      "independently of engineering's release schedule.",
    "",
    "2",
    "00:00:06.000 --> 00:00:11.000",
    "<v John Smith>Great, that makes sense to me, I'll get the roadmap doc updated today and loop " +
      "in the design team on what this means for the onboarding flow timeline.",
    "",
    "3",
    "00:00:11.000 --> 00:00:14.000",
    "<v Alex Chen>Anyway, did anyone catch the game last night?",
    "",
    "4",
    "00:00:14.000 --> 00:00:17.000",
    "<v Jane Doe>Not this time, was heads down all week.",
  ].join("\n");

  const chunks = chunkTranscript(parseCueTranscript(vtt), 5000);

  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[0].text).toContain("We're going to go with option B for the launch");
  expect(chunks[0].text).toContain("I'll get the roadmap doc updated today");
  expect(chunks[0].text).not.toContain("did anyone catch the game");
  expect(chunks[1].text).toContain("did anyone catch the game");
});

// -- Full walker: files on disk, both formats, real directory/file paths --

let workDir: string;

function setup() {
  workDir = mkdtempSync(join(tmpdir(), "gnt-prebrain-meeting-notes-"));
}

function teardown() {
  rmSync(workDir, { recursive: true, force: true });
}

test("walks a directory containing both a .vtt and a .txt export, tagging every chunk meeting-notes-export", async () => {
  setup();
  try {
    const exportDir = join(workDir, "exports");
    mkdirSync(exportDir, { recursive: true });

    writeFileSync(
      join(exportDir, "standup.vtt"),
      [
        "WEBVTT",
        "",
        "1",
        "00:00:00.000 --> 00:00:03.000",
        "<v Jane Doe>We've decided to push the launch to next quarter.",
      ].join("\n"),
    );

    writeFileSync(
      join(exportDir, "planning.txt"),
      ["[00:00:10] Ross: New vendors must be approved by finance before signature."].join("\n"),
    );

    const chunks = await walkMeetingNotesExport(exportDir);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) expect(chunk.walker).toBe("meeting-notes-export");

    const vttChunks = chunks.filter((c) => c.sourcePath === "standup.vtt");
    const txtChunks = chunks.filter((c) => c.sourcePath === "planning.txt");
    expect(vttChunks.length).toBeGreaterThan(0);
    expect(txtChunks.length).toBeGreaterThan(0);
    expect(vttChunks.map((c) => c.text).join("\n")).toContain("We've decided to push the launch to next quarter.");
    expect(txtChunks.map((c) => c.text).join("\n")).toContain(
      "New vendors must be approved by finance before signature.",
    );
  } finally {
    teardown();
  }
});

test("a single file (not a directory) is parsed directly, sourcePath is just the file name", async () => {
  setup();
  try {
    const filePath = join(workDir, "one-off.srt");
    writeFileSync(
      filePath,
      ["1", "00:00:00,000 --> 00:00:03,000", "Jane Doe: All refunds over $500 need manager approval."].join("\n"),
    );

    const chunks = await walkMeetingNotesExport(filePath);

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(chunk.sourcePath).toBe("one-off.srt");
    expect(chunks.map((c) => c.text).join("\n")).toContain("All refunds over $500 need manager approval.");
  } finally {
    teardown();
  }
});

test("a missing path produces no chunks rather than throwing", async () => {
  setup();
  try {
    const chunks = await walkMeetingNotesExport(join(workDir, "does-not-exist"));
    expect(chunks).toHaveLength(0);
  } finally {
    teardown();
  }
});

test("a file with no recognizable cue or speaker markup at all degrades to unattributed chunks instead of producing nothing", async () => {
  setup();
  try {
    const filePath = join(workDir, "notes.txt");
    writeFileSync(filePath, "General meeting notes with no speaker attribution or timestamps at all.");

    const chunks = await walkMeetingNotesExport(filePath);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.text).join("\n")).toContain("General meeting notes with no speaker attribution");
  } finally {
    teardown();
  }
});

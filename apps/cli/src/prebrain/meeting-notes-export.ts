// Meeting-notes export walker: reads local
// meeting-transcript exports from Otter.ai, Fireflies.ai, and Fathom --
// timestamped-caption files and plain-text transcripts -- and feeds them
// through the shared transcript chunker (transcript-chunk.ts, built for
// the Granola adapter specifically so this walker could reuse it rather
// than build a second speaker-turn/decision-moment chunker). Same "interim local-path
// walker, not a live connector" framing as gmail-export.ts/outlook-
// export.ts, and the closest precedent for how this file wires into
// commands/prebrain.ts and types.ts. Local-only, same as every walker in
// this directory except the two MCP-in ones: no network calls happen
// anywhere in this file.
//
// -- What these three tools actually export today --
// (see this task's own PR description for the cited sources -- every
// claim below is checked against each vendor's own current help-center
// documentation, not assumed from the sprint plan's own working title for
// this task.)
//
// Otter.ai: TXT on every plan; DOCX, PDF, and SRT are paid-plan exports.
// No WebVTT export exists.
//
// Fireflies.ai: DOCX, PDF, SRT, CSV, JSON, or MD per meeting; a separate
// whole-account bulk export additionally offers TXT. No WebVTT export
// exists either.
//
// Fathom: no native file export at all. The only built-in path is a
// "Copy Transcript" button that copies the transcript to the clipboard for
// a customer to paste wherever they want -- Fathom's own help center is
// explicit that transcripts "can't be downloaded directly."  A pasted-and-
// saved .txt file is this walker's real Fathom path.
//
// So the plan's own working assumption -- VTT and plain text as the common
// denominator -- turns out half right. None of the three vendors exports
// WebVTT specifically. What Otter and Fireflies both actually export is
// SRT, a different but structurally identical timestamped-cue subtitle
// format: same cue-block shape (a timing line, then one or more lines of
// cue text, blank-line-separated), differing only in an optional "WEBVTT"
// header, an optional cue-identifier line, and a comma vs. a period in the
// millisecond separator. Rather than this walker claiming to read "VTT"
// and silently producing nothing useful from the SRT files these two
// vendors actually hand a customer, parseCueTranscript below reads both --
// which also means a real .vtt file (from a screen-recorder, a browser
// extension, or either vendor adding VTT later) works without a rewrite.
// Plain text -- Otter's TXT, Fireflies' TXT/MD, and a saved Fathom
// clipboard paste -- is the second real common denominator, and is what a
// customer without a paid Otter/Fireflies plan is left with regardless.
//
// -- Cue parsing (SRT and VTT) --
// parseCueTranscript treats a blank-line-delimited block as a cue if any
// of its lines matches a timing line (CUE_TIMING); a block with no timing
// line at all -- a leading "WEBVTT" header, a VTT NOTE/STYLE/REGION block,
// a bare SRT index line with nothing after it -- is skipped rather than
// special-cased, so a new export quirk from one of these formats' many
// optional pieces is something this parser already tolerates rather than
// something that needs its own branch.
//
// A cue's speaker, if any, comes from a WebVTT voice tag ("<v Jane Doe>
// text") or from the flatter "Jane Doe: text" convention some export
// tools use inline instead. Real caption exports also time-slice a single
// sentence across many short cues, so consecutive cues from the same
// speaker (or an unlabeled cue right after one) are merged into one turn
// before anything reaches the shared chunker -- otherwise a single
// spoken turn would fragment into dozens of one-line "turns" and defeat
// transcript-chunk.ts's own turn-boundary and decision-moment heuristics
// (see that file's own doc comment). The merged turns are rendered back
// into the exact "Speaker: text", blank-line-delimited shape
// transcript-chunk.ts's own parseSpeakerTurns already reads -- a
// conversion step, not a second turn-chunking algorithm. Every turn-
// boundary, size-cap, and decision-moment decision still happens inside
// chunkTranscript once this hands it a normal document.
//
// -- Plain-text parsing --
// None of the three vendors' current documentation shows a byte-for-byte
// export sample: Fireflies' own docs describe the timestamp/speaker
// toggles without showing output, and Fathom's transcript is a clipboard
// paste, never a documented file format at all. transcript-chunk.ts's own
// SPEAKER_HEADER_WITH_TIMESTAMP ("Jane Doe  00:14:32" alone on a line,
// text below) and SPEAKER_INLINE_PATTERN ("Jane Doe: text") already cover
// Otter's documented plain-text layout and the speaker/timestamp/text
// shape Fathom's own transcript API schema implies for a pasted copy --
// both used unchanged, no conversion needed. What isn't covered without a
// conversion step is a bracket or paren timestamp glued onto an inline
// "Name: text" line, the shape Fireflies' own sample copy shows
// ("[00:00:10] Ross: ..."). parsePlainTextTranscript strips that shape
// (leading or trailing, bracket or paren) before handing the result to
// the shared chunker, same "conversion step in this file, not a change to
// transcript-chunk.ts" discipline the cue parser above follows.
//
// -- Format detection --
// Per file, not per customer flag: looksLikeCueFile scans for a cue
// timing line rather than trusting the file's extension, the same "sniff,
// don't trust the extension" discipline outlook-export.ts's own
// looksLikeMbox applies -- a customer's .txt file that's actually SRT-
// shaped (or a mislabeled .vtt that's actually plain text) still parses
// correctly. This is also why a single --meeting-notes flag, not three
// per-tool flags, is the right shape: nothing about which of these three
// vendors produced a given file needs to be known up front, only whether
// its content is cue-shaped or not.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, relative } from "node:path";
import { classifyDecisionProse } from "./chunk.js";
import { collectFiles } from "./text-walker.js";
import { chunkTranscript } from "./transcript-chunk.js";
import type { PrebrainChunk } from "./types.js";

const MEETING_NOTES_EXTENSIONS = [".vtt", ".srt", ".txt", ".md"];

// Same generous cap text-walker.ts uses for a single doc -- guards against
// accidentally walking into something huge (a mis-pointed directory, a
// stray recording dump) and stalling on it.
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// A cue timing line: HH:MM:SS or MM:SS, comma (SRT) or period (VTT)
// millisecond separator, an arrow, then the same on the right. Trailing
// VTT cue settings after the end timestamp (align/position/line/etc.) are
// allowed and simply ignored -- this only needs to recognize the line, not
// parse every field on it.
const CUE_TIMING = /(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s*-->\s*(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}/;

// Scoped to the first 40 non-blank lines -- a real cue file's first timing
// line always appears within a handful of lines of the top, and this
// avoids scanning a large plain-text transcript in full just to sniff its
// shape.
function looksLikeCueFile(raw: string): boolean {
  return raw
    .split("\n", 40)
    .some((line) => CUE_TIMING.test(line));
}

interface RawBlock {
  lines: string[];
}

// Blank-line-delimited runs of non-blank lines -- the same block shape
// every other chunker/parser in this directory splits on (chunk.ts's own
// splitIntoBlocks, transcript-chunk.ts's own splitIntoBlocks), reimplemented
// locally since neither exports it and this file's block shape (a cue: an
// optional identifier line, a timing line, then text) is different from
// either of theirs anyway.
function splitBlocks(content: string): RawBlock[] {
  const lines = content.split("\n");
  const blocks: RawBlock[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length > 0) {
        blocks.push({ lines: current });
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push({ lines: current });
  return blocks;
}

interface Cue {
  speaker: string | null;
  text: string;
}

// A WebVTT voice tag, e.g. "<v Jane Doe>text" or "<v.loud Jane Doe>text
// </v>" -- the optional class-list form (".loud") is part of the spec but
// not a speaker name, so it's matched and dropped along with the tag
// itself.
const VOICE_TAG = /^<v(?:\.[\w-]+)*\s+([^>]+)>([\s\S]*)$/;
// The flatter "Speaker Name: text" convention some export tools use
// inline instead of a <v> tag -- same NAME shape transcript-chunk.ts's own
// SPEAKER_INLINE_PATTERN looks for, kept local rather than imported: this
// is a cue-grouping concern (deciding which cues belong to the same turn),
// not the final turn-rendering transcript-chunk.ts already owns once this
// file hands it a document.
const CUE_INLINE_SPEAKER = /^([A-Z][\w.'-]*(?: [A-Z][\w.'-]*){0,3}):\s+(\S[\s\S]*)$/;
// Any other inline VTT markup -- <b>/<i> styling tags, <00:00:01.000>
// karaoke timing tags -- stripped from cue text wholesale; none of it is
// speaker information.
const OTHER_VTT_TAGS = /<[^>]*>/g;

// Reads one blank-line-delimited block as a cue: finds its timing line
// (wherever it falls -- after an optional SRT index or VTT cue-identifier
// line), and treats every line after it as that cue's text. A block with
// no timing line at all isn't a cue -- see this file's own header comment
// for why that's the one, generic way every non-cue block (a VTT header,
// a NOTE/STYLE/REGION block, a stray blank index) is skipped.
function parseCue(block: RawBlock): Cue | null {
  const timingIndex = block.lines.findIndex((line) => CUE_TIMING.test(line));
  if (timingIndex === -1) return null;

  const textLines = block.lines.slice(timingIndex + 1);
  if (textLines.length === 0) return null;

  const [firstLine, ...rest] = textLines;

  const voiceMatch = VOICE_TAG.exec(firstLine);
  if (voiceMatch) {
    const text = [voiceMatch[2], ...rest].join("\n").replace(/<\/v>/g, "").replace(OTHER_VTT_TAGS, "").trim();
    return { speaker: voiceMatch[1].trim(), text };
  }

  const inlineMatch = CUE_INLINE_SPEAKER.exec(firstLine);
  if (inlineMatch) {
    const text = [inlineMatch[2], ...rest].join("\n").replace(OTHER_VTT_TAGS, "").trim();
    return { speaker: inlineMatch[1], text };
  }

  return { speaker: null, text: textLines.join("\n").replace(OTHER_VTT_TAGS, "").trim() };
}

interface CueTurn {
  speaker: string | null;
  text: string;
}

// Merges consecutive cues into turns: a cue continues the previous turn
// when it shares the same speaker, or when it has no detected speaker at
// all AND the previous turn had one -- the exact "unattributed continues
// whoever's turn it was" rule parseSpeakerTurns itself applies one level
// up, in transcript-chunk.ts (see its own detectSpeaker/continuation
// handling). Deliberately not "any two consecutive unlabeled cues merge":
// a caption export with speaker labels turned off (a real, documented
// toggle on both Otter's and Fireflies' own export screens) has no
// speaker on any cue at all, and merging every one of those into a single
// turn regardless would produce one atomic turn spanning the entire file
// -- chunkTranscript never splits a turn once formed (by design, so a
// turn is never cut mid-sentence), so that single turn would become one
// oversized chunk, exactly the "whole-file dump" PrebrainChunk's own doc
// comment says a chunk must never be. Leaving each unattributed cue as
// its own turn instead lets chunkTranscript's own size cap group them
// into normal, cap-respecting chunks the ordinary way.
//
// Cues are joined with a space, not a newline, when they do merge --
// unlike chunk.ts's/transcript-chunk.ts's own block merges, which join
// whole paragraphs, cues are time-sliced mid-sentence, so a space is the
// correct join for text that was one sentence before an export tool cut
// it into captions.
function mergeCuesToTurns(cues: Cue[]): CueTurn[] {
  const turns: CueTurn[] = [];

  for (const cue of cues) {
    if (cue.text.length === 0) continue;
    const previous = turns[turns.length - 1];
    // Two nulls don't mean "the same speaker" -- they mean "unknown" twice,
    // so that case is handled by its own branch below, not this one, or
    // every unattributed cue in a captions-only file would satisfy
    // `cue.speaker === previous.speaker` (null === null) and merge into one
    // turn, exactly the bug this function's own doc comment above explains.
    const sameNamedSpeaker = cue.speaker !== null && previous !== undefined && cue.speaker === previous.speaker;
    const continuesUnattributed = cue.speaker === null && previous !== undefined && previous.speaker !== null;
    const continuesPrevious = sameNamedSpeaker || continuesUnattributed;

    if (continuesPrevious) {
      previous.text = `${previous.text} ${cue.text}`;
    } else {
      turns.push({ speaker: cue.speaker, text: cue.text });
    }
  }

  return turns;
}

function renderTurns(turns: CueTurn[]): string {
  return turns.map((turn) => (turn.speaker ? `${turn.speaker}: ${turn.text}` : turn.text)).join("\n\n");
}

// Parses a VTT- or SRT-shaped file's cues into the "Speaker: text",
// blank-line-delimited document transcript-chunk.ts's own
// parseSpeakerTurns already reads -- see this file's own header comment
// for why one parser reads both formats and why the merge step above is
// required before this reaches the shared chunker at all.
export function parseCueTranscript(raw: string): string {
  const cues: Cue[] = [];
  for (const block of splitBlocks(raw)) {
    const cue = parseCue(block);
    if (cue) cues.push(cue);
  }
  return renderTurns(mergeCuesToTurns(cues));
}

// Bracket/paren-timestamp normalization for plain-text exports -- see this
// file's own header comment for which shapes are covered and why. Applied
// line by line; a line that doesn't match any of these stays exactly as
// it was, so an already-well-formed Otter/Fathom-style line (which
// transcript-chunk.ts's own patterns already read) passes through
// unchanged.
const LEADING_BRACKET_TIMESTAMP = /^\[(?:\d{1,2}:)?\d{2}:\d{2}\]\s*/;
const TRAILING_PAREN_TIMESTAMP = /^([A-Z][\w.'-]*(?: [A-Z][\w.'-]*){0,3})\s*\((?:\d{1,2}:)?\d{2}:\d{2}\):\s*/;
const TRAILING_BRACKET_TIMESTAMP = /^([A-Z][\w.'-]*(?: [A-Z][\w.'-]*){0,3})\s*\[(?:\d{1,2}:)?\d{2}:\d{2}\]:\s*/;

export function parsePlainTextTranscript(raw: string): string {
  return raw
    .split("\n")
    .map((line) =>
      line
        .replace(LEADING_BRACKET_TIMESTAMP, "")
        .replace(TRAILING_PAREN_TIMESTAMP, "$1: ")
        .replace(TRAILING_BRACKET_TIMESTAMP, "$1: "),
    )
    .join("\n");
}

function normalizeFile(raw: string): string {
  return looksLikeCueFile(raw) ? parseCueTranscript(raw) : parsePlainTextTranscript(raw);
}

export async function walkMeetingNotesExport(notesPath: string): Promise<PrebrainChunk[]> {
  if (!existsSync(notesPath)) return [];

  const rootStat = statSync(notesPath);
  let files: string[];
  if (rootStat.isDirectory()) {
    files = collectFiles(notesPath, MEETING_NOTES_EXTENSIONS);
  } else if (rootStat.isFile()) {
    files = [notesPath];
  } else {
    return [];
  }

  const chunks: PrebrainChunk[] = [];

  for (const file of files) {
    let fileStat;
    try {
      fileStat = statSync(file);
    } catch {
      continue; // unreadable file (permissions, race) -- skip it, not fatal for the whole walk
    }
    if (fileStat.size > MAX_FILE_BYTES) continue;

    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    let body: string;
    try {
      body = normalizeFile(raw).trim();
    } catch {
      // A malformed individual export (an unparseable cue file, garbled
      // encoding) never aborts the rest of the walk -- same skip-and-report
      // bias every walker here already has (see gmail-export.ts's identical
      // handling).
      continue;
    }
    if (body.length === 0) continue;

    // A "# <title>" heading, same device mcp-granola.ts's own
    // buildMeetingDocument uses -- transcript-chunk.ts never folds a
    // markdown heading into a surrounding turn (see its own doc comment),
    // so this guarantees one file's content never merges into another's
    // first/last chunk and gives that chunk's own citation a readable title.
    const title = basename(file, extname(file));
    const document = `# ${title}\n\n${body}`;

    const sourcePath = rootStat.isDirectory() ? relative(notesPath, file).split("\\").join("/") : basename(file);

    for (const chunk of chunkTranscript(document)) {
      chunks.push({
        text: chunk.text,
        sourcePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        walker: "meeting-notes-export",
        looksLikeDecisionProse: classifyDecisionProse(chunk.text),
      });
    }
  }

  return chunks;
}

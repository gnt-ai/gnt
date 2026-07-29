// Shared transcript-chunking heuristic: a Chunker
// (see mcp-framework/types.ts) built for meeting-transcript-shaped text --
// speaker turns, not markdown paragraphs. Granola is the first connector
// that needs it; the Zoom adapter and the VTT/plain-text meeting-export
// walkers are built to reuse this module directly rather than each growing
// their own copy, so changes here are shared, not adapter-local.
//
// -- Why chunk.ts's own chunkText doesn't fit a transcript --
// chunkText's unit is a blank-line-delimited paragraph, broken hard on a
// markdown heading. A transcript's real unit is a speaker's turn -- one
// person's uninterrupted stretch of speech -- and a paragraph-based
// chunker has no idea where one turn ends and the next begins, so it can
// (and regularly would) glue the tail of one person's sentence to the
// start of someone else's reply in the same chunk, or the reverse: split
// one person's own multi-paragraph turn across chunks for no reason
// beyond a byte count. Neither is acceptable for a chunk that's about to
// become a rule's source citation -- a citation misattributed to the
// wrong speaker, or truncated mid-thought, is worse than a citation that's
// merely a little long.
//
// -- Turn parsing --
// parseSpeakerTurns splits content into blank-line-delimited blocks (the
// same shape chunk.ts's own private splitIntoBlocks uses, reimplemented
// here since chunk.ts doesn't export it) and looks at each block's first
// line for one of two speaker-header shapes real transcript exports use:
//   1. "Jane Doe  00:14:32" or "Jane Doe:" alone on its own line, the
//      speaker's own text following on the block's remaining lines
//      (Granola's and Otter's own transcript layout).
//   2. "Jane Doe: <text>" -- name, colon, text on one line (the flatter
//      style Zoom's plain-text transcript download and many export tools
//      produce).
// A block matching neither is treated as a continuation of whoever spoke
// last (an export that split one turn across a blank line) if there IS a
// last speaker, or its own unattributed turn otherwise -- so content with
// no detectable speaker markup at all degrades gracefully into the same
// paragraph-block granularity chunkText already uses, rather than
// misbehaving. This matters in practice: mcp-granola.ts's own documents
// combine a transcript with Granola's separate AI-written notes prose in
// one body, and the notes portion has no speaker markup at all.
//
// A markdown heading (chunk.ts's own HEADING_PATTERN) is never folded into
// a turn either way, attributed or not -- it always starts its own,
// non-merging unit, matching chunkText's own heading rule, so a document
// heading a walker prepends (mcp-granola.ts's "# <meeting title>") never
// gets misread as something a speaker said.
//
// -- Chunk boundaries respect turn boundaries --
// A turn, once parsed, is atomic: chunkTranscript never splits one inside
// a chunk, the same guarantee chunkText gives a paragraph block. Turns
// accumulate into a chunk under the size cap and flush once the next turn
// would cross it -- ordinary case, no different from chunkText.
//
// -- Decision-moment heuristics --
// Per the plan: prefer chunking around a plausible decision moment over a
// fixed character count alone. This reuses classifyDecisionProse
// (chunk.ts) -- the same signal-word pass every other walker's
// looksLikeDecisionProse field already runs off of downstream -- applied
// per turn, rather than inventing a second, parallel keyword list. Two
// effects, both driven by that same call:
//   1. Extended cap: once a chunk contains a decision-signal turn, its
//      size cap grows by EXTENDED_CAP_MULTIPLIER for the rest of that
//      chunk, so a reply/confirmation turn that would otherwise overflow
//      the ordinary cap by a small amount stays with the statement it's
//      confirming instead of getting cut into the next chunk.
//   2. Early close: once a chunk holds a decision-signal turn plus at
//      least one turn after it (the moment has had a chance to resolve --
//      someone replied, agreed, or moved past it) and a different speaker
//      starts a turn that does NOT itself read as decision-signal, the
//      chunk is closed right there, even if it's still well under the
//      size cap, rather than padding it with whatever unrelated small
//      talk follows. A decision moment should read as a tight, focused
//      chunk on its own, not as the first quarter of a much longer chunk
//      about something else. Guarded by MIN_CHARS_BEFORE_EARLY_CLOSE so a
//      chunk barely started doesn't close prematurely.
//
// This is a heuristic tuned for readability of the resulting chunks, not a
// classifier -- classifyDecisionProse's own doc comment in chunk.ts makes
// the same disclaimer, and it applies here for the same reason.
import { classifyDecisionProse } from "./chunk.js";
import type { TextChunk } from "./chunk.js";

const DEFAULT_MAX_CHUNK_CHARS = 1200; // mirrors chunk.ts's own MAX_CHUNK_CHARS, for consistent chunk sizing across every walker regardless of which chunker it uses
const EXTENDED_CAP_MULTIPLIER = 1.5; // see "Decision-moment heuristics" above
const MIN_CHARS_BEFORE_EARLY_CLOSE = 200; // don't early-close a decision-moment chunk that's still trivially small

const HEADING_PATTERN = /^#{1,6}\s/;

// "Jane Doe" / "Sarah" -- one to four capitalized words, allowing the
// punctuation real names use (periods for initials, hyphens, apostrophes).
const NAME = String.raw`[A-Z][\w.'-]*(?: [A-Z][\w.'-]*){0,3}`;
const TIMESTAMP = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;

// "Jane Doe  00:14:32" -- name plus a timestamp, alone on the line.
const SPEAKER_HEADER_WITH_TIMESTAMP = new RegExp(`^(${NAME})\\s+${TIMESTAMP}\\s*$`);
// "Jane Doe:" -- name plus a bare trailing colon, alone on the line (no
// timestamp available, but still clearly a header rather than dialogue).
const SPEAKER_HEADER_BARE = new RegExp(`^(${NAME}):\\s*$`);
// "Jane Doe: some spoken text" -- name, colon, and that turn's first line
// of text all on one line.
const SPEAKER_INLINE_PATTERN = new RegExp(`^(${NAME}):\\s+(\\S.*)$`);

export interface SpeakerTurn {
  /** null for a block with no detected speaker markup (see this file's own doc comment on graceful degradation). */
  speaker: string | null;
  text: string;
  startLine: number;
  endLine: number;
}

interface RawBlock {
  lines: string[];
  startLine: number;
  endLine: number;
}

// Blank-line-delimited runs of non-blank lines -- the same block shape
// chunk.ts's own private splitIntoBlocks produces, reimplemented here since
// chunk.ts doesn't export it. Every transcript export format checked while
// building this (Granola's, Zoom's plain-text download, Otter/Fireflies
// exports) separates turns with a blank line, so this is the right
// granularity to look for a speaker header at the start of.
function splitIntoBlocks(content: string): RawBlock[] {
  const lines = content.split("\n");
  const blocks: RawBlock[] = [];
  let current: string[] = [];
  let start = 1;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    if (lines[i].trim() === "") {
      if (current.length > 0) {
        blocks.push({ lines: current, startLine: start, endLine: lineNo - 1 });
        current = [];
      }
      continue;
    }
    if (current.length === 0) start = lineNo;
    current.push(lines[i]);
  }
  if (current.length > 0) {
    blocks.push({ lines: current, startLine: start, endLine: lines.length });
  }
  return blocks;
}

interface DetectedSpeaker {
  speaker: string;
  /** The rest of that turn's text already on the header line, for the inline form -- null for the header-alone forms, whose text is the block's remaining lines. */
  inlineText: string | null;
}

function detectSpeaker(firstLine: string): DetectedSpeaker | null {
  const withTimestamp = SPEAKER_HEADER_WITH_TIMESTAMP.exec(firstLine);
  if (withTimestamp) return { speaker: withTimestamp[1], inlineText: null };

  const bare = SPEAKER_HEADER_BARE.exec(firstLine);
  if (bare) return { speaker: bare[1], inlineText: null };

  const inline = SPEAKER_INLINE_PATTERN.exec(firstLine);
  if (inline) return { speaker: inline[1], inlineText: inline[2] };

  return null;
}

// Splits transcript-shaped content into speaker turns. A block whose first
// line doesn't match a speaker-header shape is folded into the previous
// turn as a continuation (if one exists and had a speaker) rather than
// starting a new one -- an export can split a single person's turn across
// a blank line, and that must not read as two different people talking. A
// markdown heading is the one exception: it never merges into a
// surrounding turn either way, so a document heading a caller prepends
// can't be misread as dialogue.
export function parseSpeakerTurns(content: string): SpeakerTurn[] {
  const blocks = splitIntoBlocks(content);
  const turns: SpeakerTurn[] = [];

  for (const block of blocks) {
    const [firstLine, ...rest] = block.lines;

    if (HEADING_PATTERN.test(firstLine)) {
      turns.push({ speaker: null, text: block.lines.join("\n"), startLine: block.startLine, endLine: block.endLine });
      continue;
    }

    const detected = detectSpeaker(firstLine);
    if (!detected) {
      const blockText = block.lines.join("\n");
      const previous = turns[turns.length - 1];
      if (previous && previous.speaker !== null) {
        previous.text = `${previous.text}\n${blockText}`;
        previous.endLine = block.endLine;
      } else {
        turns.push({ speaker: null, text: blockText, startLine: block.startLine, endLine: block.endLine });
      }
      continue;
    }

    const bodyLines = detected.inlineText !== null ? [detected.inlineText, ...rest] : rest;
    turns.push({
      speaker: detected.speaker,
      text: bodyLines.join("\n").trim(),
      startLine: block.startLine,
      endLine: block.endLine,
    });
  }

  return turns.filter((turn) => turn.text.length > 0);
}

function isDecisionTurn(turn: SpeakerTurn): boolean {
  return classifyDecisionProse(turn.text) !== "low";
}

function isHeadingTurn(turn: SpeakerTurn): boolean {
  return turn.speaker === null && HEADING_PATTERN.test(turn.text);
}

// Renders a turn back to text for the assembled chunk: "Speaker: text" when
// a speaker was attributed, the raw text otherwise (an unattributed block
// or a heading).
function renderTurn(turn: SpeakerTurn): string {
  return turn.speaker ? `${turn.speaker}: ${turn.text}` : turn.text;
}

interface TurnGroup {
  turns: SpeakerTurn[];
  chars: number;
  hasDecisionTurn: boolean;
  // Counted only once hasDecisionTurn is true -- how many turns have
  // accumulated since the decision-signal turn, i.e. how much chance the
  // moment has had to resolve (a reply, a confirmation) before this chunk
  // considers closing early. See "Decision-moment heuristics" above.
  turnsSinceDecision: number;
}

function emptyGroup(): TurnGroup {
  return { turns: [], chars: 0, hasDecisionTurn: false, turnsSinceDecision: 0 };
}

function flushGroup(group: TurnGroup, chunks: TextChunk[]): void {
  if (group.turns.length === 0) return;
  const text = group.turns.map(renderTurn).join("\n\n").trim();
  if (text.length > 0) {
    chunks.push({
      text,
      startLine: group.turns[0].startLine,
      endLine: group.turns[group.turns.length - 1].endLine,
    });
  }
}

// The Chunker (mcp-framework/types.ts's Chunker signature) every
// transcript-shaped connector uses: turns in, well-formed, turn-boundary-
// respecting, decision-moment-aware chunks out. See this file's own header
// comment for the full reasoning.
export function chunkTranscript(content: string, maxChunkChars = DEFAULT_MAX_CHUNK_CHARS): TextChunk[] {
  const turns = parseSpeakerTurns(content);
  const chunks: TextChunk[] = [];
  let group = emptyGroup();

  for (const turn of turns) {
    const lastTurn = group.turns[group.turns.length - 1];

    if (isHeadingTurn(turn) && group.turns.length > 0) {
      flushGroup(group, chunks);
      group = emptyGroup();
    }

    const conversationMovedOn =
      group.hasDecisionTurn &&
      group.turnsSinceDecision >= 1 &&
      group.chars >= MIN_CHARS_BEFORE_EARLY_CLOSE &&
      !isDecisionTurn(turn) &&
      lastTurn !== undefined &&
      turn.speaker !== lastTurn.speaker;

    if (conversationMovedOn) {
      flushGroup(group, chunks);
      group = emptyGroup();
    }

    const cap = group.hasDecisionTurn || isDecisionTurn(turn) ? Math.round(maxChunkChars * EXTENDED_CAP_MULTIPLIER) : maxChunkChars;
    const addedChars = renderTurn(turn).length + 2;
    const wouldOverflow = group.chars > 0 && group.chars + addedChars > cap;
    if (wouldOverflow) {
      flushGroup(group, chunks);
      group = emptyGroup();
    }

    group.turns.push(turn);
    group.chars += addedChars;
    if (isDecisionTurn(turn)) {
      group.hasDecisionTurn = true;
      group.turnsSinceDecision = 0;
    } else if (group.hasDecisionTurn) {
      group.turnsSinceDecision += 1;
    }
  }

  flushGroup(group, chunks);
  return chunks;
}

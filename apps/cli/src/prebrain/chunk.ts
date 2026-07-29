// Shared chunking heuristic used by every walker in this directory --
// splits a file's raw text into candidate decision-prose chunks,
// never a whole-file blob and never mid-sentence.
//
// One pass, two rules, both operating on blank-line-delimited blocks:
//   1. a markdown heading (`#`..`######`) always starts a new chunk --
//      this is what makes chunking respect a doc's own section structure
//      without a separate markdown parser.
//   2. otherwise, blocks accumulate into the current chunk until adding
//      the next one would cross MAX_CHUNK_CHARS, then a new chunk starts.
//      A single block larger than MAX_CHUNK_CHARS on its own still becomes
//      its own chunk rather than being split -- this is a heuristic, not a
//      hard limit, and never breaking mid-paragraph matters more than
//      respecting the cap exactly.
// This also happens to be a reasonable default for non-markdown text (lint
// configs, CI yaml, plain .txt) -- there just aren't any heading matches,
// so it falls back to pure size-capped paragraph grouping.
import type { DecisionProseSignal } from "./types.js";

const MAX_CHUNK_CHARS = 1200;
const HEADING_PATTERN = /^#{1,6}\s/;

export interface TextChunk {
  text: string;
  startLine: number;
  endLine: number;
}

interface RawBlock {
  lines: string[];
  startLine: number;
  endLine: number;
}

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

export function chunkText(content: string, maxChunkChars = MAX_CHUNK_CHARS): TextChunk[] {
  const blocks = splitIntoBlocks(content);
  const chunks: TextChunk[] = [];

  let group: RawBlock[] = [];
  let groupChars = 0;

  const flush = () => {
    if (group.length === 0) return;
    const text = group.map((b) => b.lines.join("\n")).join("\n\n").trim();
    if (text.length > 0) {
      chunks.push({ text, startLine: group[0].startLine, endLine: group[group.length - 1].endLine });
    }
    group = [];
    groupChars = 0;
  };

  for (const block of blocks) {
    const blockText = block.lines.join("\n");
    const isHeading = HEADING_PATTERN.test(block.lines[0]);
    const wouldOverflow = groupChars > 0 && groupChars + blockText.length + 2 > maxChunkChars;
    if (group.length > 0 && (isHeading || wouldOverflow)) {
      flush();
    }
    group.push(block);
    groupChars += blockText.length + 2;
  }
  flush();

  return chunks;
}

// Decision-prose vs. boilerplate is deliberately a coarse keyword pass, not
// a classifier -- see DecisionProseSignal's doc comment in types.ts. This
// is more 2.3's job than this task's; the bar here is "cheap enough to run
// on every chunk and better than nothing for the command's summary."
const DECISION_SIGNAL_WORDS = [
  "must",
  "must not",
  "should",
  "shall",
  "never",
  "always",
  "required",
  "require",
  "unless",
  "except",
  "exception",
  "threshold",
  "escalate",
  "approve",
  "reject",
  "deny",
  "block",
  "policy",
  "not allowed",
  "do not",
  "don't",
  "before merging",
  "before shipping",
  "if ",
  // Added for the transcript chunker (transcript-chunk.ts):
  // the words above are tuned for policy-document prose ("must", "shall",
  // "required"), but a decision made out loud in a meeting usually reads
  // more like an announcement than a policy statement -- "we're going to
  // ship next week", "let's go with option B", "we've decided to push the
  // launch". Added here rather than as a second, parallel list so every
  // chunk (transcript or not) benefits from the same signal, not just the
  // ones a transcript-shaped connector produces.
  "we're going to",
  "let's go with",
  "we've decided",
  "decided to",
];

const BOILERPLATE_SIGNAL_WORDS = [
  "license",
  "badge",
  "table of contents",
  "getting started",
  "changelog",
  "npm install",
  "yarn add",
  "pnpm install",
  "bun install",
  "code of conduct",
];

export function classifyDecisionProse(text: string): DecisionProseSignal {
  const lower = text.toLowerCase();
  const decisionHits = DECISION_SIGNAL_WORDS.filter((w) => lower.includes(w)).length;
  const boilerplateHits = BOILERPLATE_SIGNAL_WORDS.filter((w) => lower.includes(w)).length;

  if (boilerplateHits > 0 && decisionHits === 0) return "low";
  if (decisionHits >= 2) return "high";
  if (decisionHits === 1) return "medium";
  return "low";
}

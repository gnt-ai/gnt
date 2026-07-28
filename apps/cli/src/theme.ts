import chalk from "chalk";

// Mirrors apps/web/app/globals.css's tokens exactly (--foreground, --muted,
// --accent-brand, --success) — one brand color, used sparingly, same
// restraint as the site. Never reach for a raw chalk.* call outside this
// file; add a semantic helper here instead, so the palette stays a single
// source of truth.
const FOREGROUND = "#e5e2e1";
const MUTED = "#c4c7c8";
const DIM = "#6b6b6b";
const BRAND = "#d0212b";
const SUCCESS = "#00ff85";

export const text = chalk.hex(FOREGROUND);
export const muted = chalk.hex(MUTED);
export const dim = chalk.hex(DIM);
export const bold = chalk.hex(FOREGROUND).bold;
export const error = chalk.hex(BRAND);
export const success = chalk.hex(SUCCESS);

export function ok(message: string): string {
  return `${success("✓")} ${text(message)}`;
}

export function fail(message: string): string {
  return `${error("✗")} ${error(message)}`;
}

// Aligns a set of label: value lines on the longest label — used for
// status/summary panels (status.ts, keys.ts) so values line up in a
// column instead of drifting with label length.
export function keyValueLines(rows: Array<[string, string]>): string[] {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${muted(`${label}:`.padEnd(width + 1))} ${value}`);
}

// Sharp corners only — matches the site's --radius: 0, no rounded UI
// anywhere in this brand.
const BOX = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };

export function box(lines: string[], width: number): string {
  const top = BOX.tl + BOX.h.repeat(width + 2) + BOX.tr;
  const bottom = BOX.bl + BOX.h.repeat(width + 2) + BOX.br;
  const body = lines.map((line) => `${BOX.v} ${padVisible(line, width)} ${BOX.v}`);
  return [dim(top), ...body, dim(bottom)].join("\n");
}

// eslint-disable-next-line no-control-regex -- stripping ANSI escapes to measure a colored string's visible width
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function visibleLength(s: string): number {
  return s.replace(ANSI_PATTERN, "").length;
}

function padVisible(s: string, width: number): string {
  const pad = Math.max(0, width - visibleLength(s));
  return s + " ".repeat(pad);
}

// Greedy word wrap for text going inside a fixed-width box() — box() only
// pads short lines, it doesn't wrap long ones.
export function wrapText(input: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of input.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (let word of paragraph.split(" ")) {
      // A single unbroken token longer than width (a URL, a hash) can't
      // be wrapped by inserting spaces — hard-chunk it instead, otherwise
      // it overflows whatever fixed-width box this ends up inside.
      while (word.length > width) {
        if (current) {
          lines.push(current);
          current = "";
        }
        lines.push(word.slice(0, width));
        word = word.slice(width);
      }
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > width && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

// success ≥0.8, error <0.5, muted between — a semantic reliability signal
// on the rule's own extraction confidence, distinct from the brand accent.
export function confidenceColor(value: number): (s: string) => string {
  if (value >= 0.8) return success;
  if (value < 0.5) return error;
  return muted;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export function spinner(label: string): { stop: (finalLine?: string) => void } {
  if (!process.stdout.isTTY) {
    process.stdout.write(`${label}\n`);
    return { stop: (finalLine) => finalLine && process.stdout.write(`${finalLine}\n`) };
  }

  let frame = 0;
  const render = () => {
    process.stdout.write(`\r${dim(SPINNER_FRAMES[frame])} ${text(label)}`);
    frame = (frame + 1) % SPINNER_FRAMES.length;
  };
  render();
  const timer = setInterval(render, SPINNER_INTERVAL_MS);

  return {
    stop(finalLine?: string) {
      clearInterval(timer);
      // Clear the spinner line, then print the final state on a fresh line.
      process.stdout.write(`\r${" ".repeat(label.length + 2)}\r`);
      if (finalLine) process.stdout.write(`${finalLine}\n`);
    },
  };
}

// Ported from apps/api/src/gnt/pipeline/sanitize.py -- read that file's
// own docstring for the two-layer defense this is one half of: this
// function strips/escapes anything that looks like tool-call syntax or
// system-prompt markers before text reaches a model; the delimited-
// data-block wrapping in ./wrap.ts is the complementary layer that tells
// the model explicitly "this is data, not instructions." Neither layer
// tries to be a general injection classifier on its own.
//
// This is security-relevant code. It is ported faithfully -- same regex
// categories, same bounded brace-matching JSON scan, same fixed
// replacement marker -- not approximated from memory.
//
// One deliberate difference from the Python source, forced by the two
// languages' different \b semantics: Python's re module treats \b as a
// Unicode-aware word boundary by default, so a leading \b in front of the
// Chinese injection phrase below still matches (CJK characters count as
// \w in Python 3's Unicode-aware mode). JS's \b is always ASCII-only
// ([A-Za-z0-9_]), even with the `u` flag -- CJK characters read as
// non-word on both sides of the boundary, so a literal \b would silently
// never match the Chinese alternative. INJECTION_START below reproduces
// Python's actual (Unicode-aware) \b behavior with an explicit negative
// lookbehind over \p{L}/\p{N}/_, so both the English and Chinese cases
// match exactly like sanitize.py does.
const XML_STYLE_MARKERS =
  /<\s*\/?\s*(?:system|assistant|human|tool_use|tool_result|tool_call|instructions?)\b[^>]*>/gi;

const SPECIAL_TOKENS = /<\|[^|<>]{1,64}\|>/g;

const BRACKET_MARKERS = /\[\/?(?:INST|SYS)\]/gi;

// Leading boundary only -- ported comment from sanitize.py: several
// alternatives end in punctuation ("...:"), and a trailing \b right after
// a non-word char fails whenever the next real character (a space,
// another colon, end of string) is also non-word, which is the common
// case. Missing a real attempt is worse than the small extra
// false-positive surface this trades.
const INJECTION_START = String.raw`(?<![\p{L}\p{N}_])`;
const INJECTION_PHRASES = new RegExp(
  `${INJECTION_START}(?:` +
    "ignore\\s+(?:all\\s+|the\\s+)?(?:prior|previous)\\s+instructions" +
    "|disregard\\s+(?:all\\s+|the\\s+)?(?:prior|previous)\\s+instructions" +
    "|you\\s+are\\s+now\\s+(?:a|an|the)" +
    "|new\\s+instructions\\s*:" +
    "|system\\s+prompt\\s*:" +
    "|act\\s+as\\s+(?:the\\s+|a\\s+)?system" +
    // Non-English coverage is deliberately narrow (ported verbatim from
    // sanitize.py): just the highest-value "ignore
    // previous instructions" variant in Spanish and Chinese, the two
    // next-largest languages after English in this product's traffic --
    // not full per-language parity with the English list above. The
    // universal delimited-wrapper convention (./wrap.ts) is the real
    // defense; this only narrows the gap for the most common non-English
    // attempt.
    "|ignora[rd]?\\s+(?:todas\\s+)?las\\s+instrucciones\\s+(?:anteriores|previas)" +
    "|忽略(?:之前|以上|先前)的?(?:所有)?(?:指令|说明|指示)" +
    ")",
  "giu",
);

// 3+ backticks -- the standard markdown fence marker; captured text
// containing one could close a fenced data block early in a prompt that
// wraps captures that way.
const CODE_FENCE = /`{3,}/g;

const REGEX_PATTERNS = [XML_STYLE_MARKERS, SPECIAL_TOKENS, BRACKET_MARKERS, INJECTION_PHRASES];

const FAKE_TOOL_TYPES = new Set(["tool_use", "tool_result", "system"]);

// Bounds how far a single brace-matching scan looks before giving up --
// not a security control (worst case is just "this blob doesn't get
// flagged"), just keeps sanitize() cheap on pathological input. Same
// value as sanitize.py's _MAX_JSON_SCAN_CHARS.
const MAX_JSON_SCAN_CHARS = 4000;

const MARKER = "[flagged-content-removed]";

// Scans forward from an opening '{' for its matching '}', tracking
// string literals so a brace inside a quoted value doesn't throw off the
// depth count -- direct port of sanitize.py's _find_matching_brace.
function findMatchingBrace(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  const end = Math.min(text.length, start + MAX_JSON_SCAN_CHARS);
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

// Real JSON parsing, not regex -- the only reliable way to tell a
// genuine tool_use/tool_result/system payload from ordinary text that
// happens to contain similar-looking characters, at any nesting depth.
// Direct port of sanitize.py's _defang_fake_tool_json.
function defangFakeToolJson(text: string): string {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] === "{") {
      const end = findMatchingBrace(text, i);
      if (end !== null) {
        const candidate = text.slice(i, end + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(candidate);
        } catch {
          parsed = null;
        }
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          const type = (parsed as Record<string, unknown>).type;
          if (typeof type === "string" && FAKE_TOOL_TYPES.has(type)) {
            out.push(MARKER);
            i = end + 1;
            continue;
          }
        }
      }
    }
    out.push(text[i] ?? "");
    i += 1;
  }
  return out.join("");
}

// Defangs captured text before it reaches a model. The replacement
// marker is fixed and generic -- it never echoes the matched text back,
// so (a) the dangerous characters genuinely don't survive anywhere in
// the output, not even inside a label, and (b) sanitizing already-
// sanitized text is a true no-op, since the marker itself can't match
// any of the patterns it replaces. Direct port of sanitize.py's
// sanitize().
export function sanitize(text: string): string {
  if (!text) return text;
  let result = text;
  for (const pattern of REGEX_PATTERNS) {
    result = result.replace(pattern, MARKER);
  }
  result = defangFakeToolJson(result);
  result = result.replace(CODE_FENCE, (match) => "'".repeat(match.length));
  return result;
}

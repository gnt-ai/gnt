"""Strips or escapes anything that looks like tool-call syntax or
system-prompt markers, before storage — a pure function, no LLM call, so
it's cheap to run on every captured string and trivially testable.

This is one layer of defense, not the whole story: extraction/serving
prompts still wrap captured text in delimited data blocks and tell the
model it's data, never instructions — untrusted external content must
never be interpreted as instructions to the model, which is the core
defense against prompt injection here — this function narrows the
specific vectors that survive even inside such a wrapper: a
sequence that closes the wrapper early, a fake tool_use/tool_result JSON
blob, a special-token-style marker, or a plain-English instruction
override. It does not try to be a general injection classifier.
"""

import json
import re

_XML_STYLE_MARKERS = re.compile(
    r"<\s*/?\s*(?:system|assistant|human|tool_use|tool_result|tool_call|instructions?)\b[^>]*>",
    re.IGNORECASE,
)
_SPECIAL_TOKENS = re.compile(r"<\|[^|<>]{1,64}\|>")
_BRACKET_MARKERS = re.compile(r"\[/?(?:INST|SYS)\]", re.IGNORECASE)
_INJECTION_PHRASES = re.compile(
    # Leading \b only — several alternatives end in punctuation ("...:"),
    # and a trailing \b right after a non-word char fails whenever the
    # next real character (a space, another colon, end of string) is
    # also non-word, which is the common case. Missing a real attempt
    # is worse than the small extra false-positive surface this trades.
    r"\b(?:"
    r"ignore\s+(?:all\s+|the\s+)?(?:prior|previous)\s+instructions"
    r"|disregard\s+(?:all\s+|the\s+)?(?:prior|previous)\s+instructions"
    r"|you\s+are\s+now\s+(?:a|an|the)"
    r"|new\s+instructions\s*:"
    r"|system\s+prompt\s*:"
    r"|act\s+as\s+(?:the\s+|a\s+)?system"
    # Non-English coverage is deliberately narrow: just the highest-value
    # "ignore previous instructions" variant in Spanish and
    # Chinese, the two next-largest languages after English in this product's
    # traffic — not full per-language parity with the English list above. The
    # universal delimited-wrapper convention is the real defense; this only
    # narrows the gap for the most common non-English attempt.
    r"|ignora[rd]?\s+(?:todas\s+)?las\s+instrucciones\s+(?:anteriores|previas)"
    r"|忽略(?:之前|以上|先前)的?(?:所有)?(?:指令|说明|指示)"
    r")",
    re.IGNORECASE,
)
# 3+ backticks — the standard markdown fence marker; captured text
# containing one could close a fenced data block early in a prompt that
# wraps captures that way.
_CODE_FENCE = re.compile(r"`{3,}")

_REGEX_PATTERNS = (_XML_STYLE_MARKERS, _SPECIAL_TOKENS, _BRACKET_MARKERS, _INJECTION_PHRASES)
_FAKE_TOOL_TYPES = {"tool_use", "tool_result", "system"}
# Bounds how far a single brace-matching scan looks before giving up —
# not a security control (worst case is just "this blob doesn't get
# flagged"), just keeps sanitize() cheap on pathological input.
_MAX_JSON_SCAN_CHARS = 4000

_MARKER = "[flagged-content-removed]"


def _find_matching_brace(text: str, start: int) -> int | None:
    """Scans forward from an opening '{' for its matching '}', tracking
    string literals so a brace inside a quoted value doesn't throw off
    the depth count — a plain [^{}]* regex body can't do this and either
    misses nested objects or gets confused by braces in string content."""
    depth = 0
    in_string = False
    escaped = False
    end = min(len(text), start + _MAX_JSON_SCAN_CHARS)
    for i in range(start, end):
        c = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                in_string = False
            continue
        if c == '"':
            in_string = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
    return None


def _defang_fake_tool_json(text: str) -> str:
    """Real JSON parsing, not regex — the only reliable way to tell a
    genuine tool_use/tool_result/system payload from ordinary text that
    happens to contain similar-looking characters, at any nesting depth."""
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        if text[i] == "{":
            end = _find_matching_brace(text, i)
            if end is not None:
                candidate = text[i : end + 1]
                try:
                    parsed = json.loads(candidate)
                except (json.JSONDecodeError, RecursionError):
                    parsed = None
                if isinstance(parsed, dict) and parsed.get("type") in _FAKE_TOOL_TYPES:
                    out.append(_MARKER)
                    i = end + 1
                    continue
        out.append(text[i])
        i += 1
    return "".join(out)


def sanitize(text: str) -> str:
    """Defangs captured text before it's stored. The replacement marker is
    fixed and generic — it never echoes the matched text back, so (a) the
    dangerous characters genuinely don't survive anywhere in the output,
    not even inside a label, and (b) sanitizing already-sanitized text is
    a true no-op, since the marker itself can't match any of the
    patterns it replaces."""
    if not text:
        return text
    result = text
    for pattern in _REGEX_PATTERNS:
        result = pattern.sub(_MARKER, result)
    result = _defang_fake_tool_json(result)
    result = _CODE_FENCE.sub(lambda m: "'" * len(m.group(0)), result)
    return result

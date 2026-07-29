"""Shared types for the server-side privacy gate.

Python port of apps/cli/src/privacy-gate/types.ts, with one deliberate
shape difference: GateLayer here has no "contextual" member. The CLI gate's
layer 3 is a local-model contextual pass that only makes sense on a
customer's own device (see index.ts's "no customer-owned local model"
framing) -- there is no equivalent concept server-side, and the founder
decision behind this task scopes layer 3 out entirely rather than porting
a stub. See apps/api/src/gnt/pipeline/privacy_gate/__init__.py's module
docstring for the full reasoning, including the bigger architectural
difference (no detokenization step -- masking here is permanent).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

# One placeholder family per entity kind, numbered per distinct value
# within that kind ([EMAIL_1], [EMAIL_2], ...). A Literal (not a bare str)
# for the same reason the CLI's union type is: a typo in a layer module is
# a type-checker-visible error, not a silent mismatch with the redaction
# record (see redaction_record.py) reading it later.
PlaceholderKind = Literal[
    "PERSON",
    "EMAIL",
    "KEY",
    "CREDIT_CARD",
    "SSN",
    "PHONE",
    "IP",
    "ORG",
    "ADDRESS",
    "AMOUNT",
]

# Which layer found a given hit. "amounts" is the policy-vs-personal
# classification pass (layer2b_amounts.py) -- named for its position in the
# pipeline (it runs after "ner"), same convention the CLI's own types.ts
# comment documents. No "contextual" member -- see this module's docstring.
GateLayer = Literal["deterministic", "ner", "amounts"]


@dataclass(frozen=True)
class DetectionHit:
    """A single detector hit, kept around after masking so the redaction
    record (redaction_record.py) can summarize "what was masked, by which
    layer" without re-deriving it from the mapping alone. `value` is the
    real value that got replaced -- present here so amounts/index tests can
    assert on it directly, but never persisted anywhere past the request
    that produced it (see redaction_record.py's own docstring)."""

    placeholder: str  # e.g. "[EMAIL_1]"
    kind: PlaceholderKind
    layer: GateLayer
    value: str
    start: int  # offset into the text *as this layer saw it*, not the original input
    end: int  # exclusive


@dataclass(frozen=True)
class RawMatch:
    """A raw candidate match a detector or the NER layer found in text,
    before it's been resolved against overlaps with other matches and
    turned into a placeholder substitution."""

    kind: PlaceholderKind
    value: str
    start: int
    end: int  # exclusive


@dataclass
class LayerResult:
    """What a single layer produces: the text after that layer's
    substitutions, plus the hits it recorded. Each layer's output text
    becomes the next layer's input."""

    text: str
    hits: list[DetectionHit] = field(default_factory=list)


@dataclass
class PrivacyGateMapping:
    """Bidirectional lookup -- real value -> placeholder and back. The CLI
    gate needs both directions for its detokenization step; this
    server-side gate never detokenizes (masking is permanent here -- see
    __init__.py), so only value_to_placeholder is actually consumed
    downstream today. Both directions are kept anyway: it's the same
    mapping shape the CLI gate returns, it costs nothing to keep, and a
    future caller inspecting "did we already mask this value" (registry.has)
    needs it regardless."""

    value_to_placeholder: dict[str, str]
    placeholder_to_value: dict[str, str]


@dataclass
class PrivacyGateResult:
    masked_text: str
    mapping: PrivacyGateMapping
    hits: list[DetectionHit]

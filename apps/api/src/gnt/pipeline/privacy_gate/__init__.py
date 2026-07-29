"""The server-side privacy gate -- a mandatory blocking step, not an
optional pass. Every ingestion path that receives third-party content
without a human on this device deliberately choosing to expose that exact
text to gnt (today: routers/webhooks.py's ingest_webhook; future
Slack-thread watchers and MCP-in connectors will be the same shape)
must run that content's title/body/source through this before it's stored,
per the founder decision recorded in this task's PR description.

Ports layers 1, 2, and 2b of the CLI gate (apps/cli/src/privacy-gate/) --
see layer1_deterministic.py, layer2_ner.py, and layer2b_amounts.py for the
full per-layer reasoning, each carried over from its TS counterpart along
with the detector choices and false-positive tradeoffs, not just the
syntax. Layer 3 (the CLI's local-model contextual pass) is deliberately
NOT ported -- it doesn't apply here (there is no "customer's own local
model" concept on a server), and the founder decision behind this task
explicitly scopes it out rather than porting a no-op stub.

-- The one thing that makes this NOT just "the CLI gate, but in Python" --

The CLI gate detokenizes: mask -> send to a cloud model (which never sees
real values) -> the model's response still has placeholder tokens -> the
CLI swaps them back to real values using a mapping held only in the CLI
process's own memory. That works because the CLI's entire flow runs on one
device that holds both the masked text and the real-value mapping the
whole time.

A server-side gate has no equivalent "customer's device": Zapier (or a
future Slack watcher, or MCP-in connector) posts straight to gnt's API,
and gnt's server is the only thing that ever touches this content, masked
or not. If this module masked before storage and then kept a mapping to
unmask later, that mapping would have to live somewhere -- and if it lives
on gnt's server, gnt's server still effectively holds the raw data (split
into two recoverable pieces), which does not honestly satisfy this
design's own "no code path sends raw source text to gnt servers"
requirement.

So: masking here is PERMANENT. There is no detokenize step in this
package, and it must never grow one for this ingestion path -- do not port
detokenize.ts or redaction-report.ts's real-value-bearing report format
(see redaction_record.py for the server-appropriate, values-never-
persisted replacement).

This is the right design, not just an acceptable compromise: layer 2b's
whole reason for existing (see layer2b_amounts.py) is telling genuine
policy content ("refunds after 30 days need approval") apart from
incidental personal specifics that happen to be mentioned in the same
breath. For ambient third-party ingestion specifically, the valuable
content is almost always policy-shaped, not personal-data-shaped --
permanently masking incidental PII while leaving policy substance intact
preserves full reviewability for what actually matters. The honest
tradeoff: a rule that is genuinely, essentially about one specific named
person or exact figure comes out of this gate with that detail permanently
replaced by a placeholder, with no way to recover it afterward. That's a
real, deliberate cost of this design, not a bug -- flagged here, in this
PR's description, and in create_draft_rule's own docstring, not buried.
"""

from __future__ import annotations

from .layer1_deterministic import run_deterministic_layer
from .layer2_ner import run_ner_layer
from .layer2b_amounts import run_amounts_layer
from .registry import PlaceholderRegistry
from .types import (
    DetectionHit,
    GateLayer,
    LayerResult,
    PlaceholderKind,
    PrivacyGateMapping,
    PrivacyGateResult,
)

__all__ = [
    "DetectionHit",
    "GateLayer",
    "LayerResult",
    "PlaceholderKind",
    "PrivacyGateMapping",
    "PrivacyGateResult",
    "apply_privacy_gate",
    "mask_fields",
]


def _run_layers(text: str, registry: PlaceholderRegistry) -> LayerResult:
    """Runs layers 1, 2, and 2b in order over `text`, each on the previous
    layer's output, sharing one PlaceholderRegistry so a value masked by an
    earlier layer (or seen twice) always gets the same placeholder. No
    network calls anywhere in this call graph -- same local-first-style
    constraint the CLI gate's index.ts documents, adapted here to mean
    "does not call out to another service mid-request", since this already
    runs on gnt's own infrastructure rather than the customer's device."""
    layer1 = run_deterministic_layer(text, registry)
    layer2 = run_ner_layer(layer1.text, registry)
    layer2b = run_amounts_layer(layer2.text, registry)
    hits = [*layer1.hits, *layer2.hits, *layer2b.hits]
    return LayerResult(text=layer2b.text, hits=hits)


def apply_privacy_gate(text: str) -> PrivacyGateResult:
    """Runs the full gate over one string, with its own fresh registry.
    Mirrors the CLI's applyPrivacyGate(text) signature 1:1 -- this is what
    test_privacy_gate_*.py call directly. For masking more than one field
    of the same rule with placeholder numbering shared across fields, use
    mask_fields instead."""
    registry = PlaceholderRegistry()
    result = _run_layers(text, registry)
    return PrivacyGateResult(masked_text=result.text, mapping=registry.to_mapping(), hits=result.hits)


def mask_fields(fields: dict[str, str | None]) -> tuple[dict[str, str | None], list[DetectionHit]]:
    """Masks several text fields belonging to ONE rule (title/body/source)
    through a single shared PlaceholderRegistry, so a value that appears in
    more than one field -- an email in both the title and the body -- ,
    collapses onto the same placeholder number rather than minting a fresh
    one per field. Same consistency guarantee the CLI gate's shared
    registry already gives across layers within one call, extended here
    across fields within one rule.

    routers/rules.py's create_draft_rule is the one caller. A None/empty
    field passes through unchanged (mirrors that function's own "source is
    optional" handling) rather than being coerced into an empty-string gate
    run."""
    registry = PlaceholderRegistry()
    masked: dict[str, str | None] = {}
    hits: list[DetectionHit] = []
    for key, value in fields.items():
        if not value:
            masked[key] = value
            continue
        result = _run_layers(value, registry)
        masked[key] = result.text
        hits.extend(result.hits)
    return masked, hits

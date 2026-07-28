"""Structured, per-rule record of what the server-side privacy gate
masked -- the closest equivalent this ingestion path has to the CLI gate's
local redaction-report.ts, adapted for a fundamentally different trust
boundary.

The CLI's redaction report is written to the customer's OWN device
(~/.gnt/redaction-reports/) and deliberately DOES include the real values
that got masked -- that's safe there because the file never leaves the
machine that already had those values in plaintext, and it's what makes
"your raw data never touches gnt's servers" inspectable rather than a bare
claim (see that file's own docstring).

Neither of those things is true here. This record is built server-side,
from content a webhook already delivered to gnt's API, and it gets stored
in gnt's own systems (see routers/rules.py's create_draft_rule, which
appends it to the rule's audit trail via append_audit) -- NOT a customer-
only location. Including real values in it would mean gnt's server
persists exactly the raw values the whole point of running this gate was
to avoid ever storing. So this record is deliberately values-free: kind,
layer, and placeholder per masked item, never the original value. A
customer reviewing a webhook-ingested rule can see what KIND of thing got
masked and by which layer -- enough to sanity-check the gate actually ran
and to understand why a placeholder appears in the rule body -- without
this record itself becoming a second copy of the data the gate exists to
protect.
"""

from __future__ import annotations

from typing import Any

from .types import DetectionHit


def build_redaction_record(hits: list[DetectionHit]) -> dict[str, Any]:
    """Pure function, no I/O -- same split as the CLI's
    buildRedactionReport/writeRedactionReport, minus the write half (this
    goes into the audit trail via append_audit, not a file -- see
    routers/rules.py). Ordering matches types.py's PlaceholderKind
    declaration order and __init__.py's layer sequence, same convention
    the CLI's redaction-report.ts uses so section order stays in sync with
    those files rather than drifting independently."""
    kind_order = ("PERSON", "EMAIL", "KEY", "CREDIT_CARD", "SSN", "PHONE", "IP", "ORG", "ADDRESS", "AMOUNT")
    layer_order = ("deterministic", "ner", "amounts")

    kind_counts: dict[str, int] = {}
    layer_counts: dict[str, int] = {}
    for hit in hits:
        kind_counts[hit.kind] = kind_counts.get(hit.kind, 0) + 1
        layer_counts[hit.layer] = layer_counts.get(hit.layer, 0) + 1

    return {
        "total_masked": len(hits),
        "kind_counts": {kind: kind_counts[kind] for kind in kind_order if kind in kind_counts},
        "layer_counts": {layer: layer_counts[layer] for layer in layer_order if layer in layer_counts},
        # Deliberately no "value" field on any item -- see this module's
        # own docstring for why. Not split per rule field (title/body/
        # source) either -- kind + layer is enough for a customer to sanity
        # -check the gate ran and understand a placeholder's origin, and
        # DetectionHit doesn't carry which field it came from in the first
        # place (mask_fields runs each field through its own gate pass).
        "items": [{"placeholder": hit.placeholder, "kind": hit.kind, "layer": hit.layer} for hit in hits],
    }

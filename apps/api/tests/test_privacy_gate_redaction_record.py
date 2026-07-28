"""Tests for redaction_record.py and mask_fields -- the two pieces
create_draft_rule (routers/rules.py) actually calls, that the layer-level
test files above don't otherwise cover directly."""

from gnt.pipeline.privacy_gate import apply_privacy_gate, mask_fields
from gnt.pipeline.privacy_gate.redaction_record import build_redaction_record


def test_build_redaction_record_never_includes_a_real_value():
    result = apply_privacy_gate("Contact Jane Smith at jane@acme.com about her $50,000 balance.")
    record = build_redaction_record(result.hits)

    serialized = str(record)
    assert "Jane Smith" not in serialized
    assert "jane@acme.com" not in serialized
    assert "$50,000" not in serialized
    assert "50,000" not in serialized


def test_build_redaction_record_counts_and_lists_items_by_kind_and_layer():
    result = apply_privacy_gate("Her SSN is 078-05-1120 and her email is jane@acme.com.")
    record = build_redaction_record(result.hits)

    assert record["total_masked"] == 2
    assert record["kind_counts"] == {"EMAIL": 1, "SSN": 1}
    assert record["layer_counts"] == {"deterministic": 2}
    assert {"placeholder": "[SSN_1]", "kind": "SSN", "layer": "deterministic"} in record["items"]
    assert {"placeholder": "[EMAIL_1]", "kind": "EMAIL", "layer": "deterministic"} in record["items"]


def test_build_redaction_record_on_no_hits_is_an_empty_but_well_shaped_record():
    record = build_redaction_record([])
    assert record == {"total_masked": 0, "kind_counts": {}, "layer_counts": {}, "items": []}


def test_mask_fields_shares_one_placeholder_across_fields_for_a_repeated_value():
    masked, hits = mask_fields(
        {
            "title": "Refund escalation for jane@acme.com",
            "body": "Contact jane@acme.com if the customer disputes the charge.",
            "source": None,
        }
    )
    assert masked["title"] == "Refund escalation for [EMAIL_1]"
    assert masked["body"] == "Contact [EMAIL_1] if the customer disputes the charge."
    assert masked["source"] is None
    assert len([h for h in hits if h.kind == "EMAIL"]) == 2


def test_mask_fields_leaves_a_none_or_empty_field_untouched():
    masked, hits = mask_fields({"title": "Plain title", "body": "Plain body.", "source": ""})
    assert masked == {"title": "Plain title", "body": "Plain body.", "source": ""}
    assert hits == []

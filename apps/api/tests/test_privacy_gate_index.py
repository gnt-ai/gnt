"""End-to-end tests for apply_privacy_gate: the full layer 1 -> 2 -> 2b
pipeline, the bidirectional mapping shape, and idempotency (running the
gate twice must not re-mask its own output). Ported from
apps/cli/test/privacy-gate/index.test.ts, with one structural difference:
that suite also asserts every hit's layer is one of
["deterministic", "ner", "contextual"] -- there is no "contextual" layer
here (layer 3 is deliberately not ported, see
gnt.pipeline.privacy_gate's module docstring), so this file's equivalent
assertion checks against ["deterministic", "ner", "amounts"] instead.
"""

from gnt.pipeline.privacy_gate import apply_privacy_gate


def test_masks_deterministic_and_ner_hits_together_in_one_run():
    text = "Jane Smith works there. Her SSN is 078-05-1120 and her email is jane@acme.com."
    result = apply_privacy_gate(text)
    assert result.masked_text == "[PERSON_1] works there. Her SSN is [SSN_1] and her email is [EMAIL_1]."


def test_the_mapping_reverses_exactly_in_both_directions():
    text = "Reach Jane Smith at jane@acme.com."
    result = apply_privacy_gate(text)

    email_placeholder = result.mapping.value_to_placeholder["jane@acme.com"]
    assert email_placeholder == "[EMAIL_1]"
    assert result.mapping.placeholder_to_value[email_placeholder] == "jane@acme.com"

    name_placeholder = result.mapping.value_to_placeholder["Jane Smith"]
    assert name_placeholder == "[PERSON_1]"
    assert result.mapping.placeholder_to_value[name_placeholder] == "Jane Smith"


def test_every_hits_placeholder_resolves_in_the_mapping_and_carries_enough_for_a_redaction_record():
    text = "Card 4242 4242 4242 4242 was charged to jane@acme.com."
    result = apply_privacy_gate(text)

    assert len(result.hits) > 0
    for hit in result.hits:
        assert result.mapping.placeholder_to_value[hit.placeholder] == hit.value
        assert hit.layer in ("deterministic", "ner", "amounts")


def test_running_the_gate_twice_does_not_re_mask_its_own_placeholders():
    text = "Jane Smith's SSN is 078-05-1120, email jane@acme.com, at Acme Corporation."
    first = apply_privacy_gate(text)
    second = apply_privacy_gate(first.masked_text)

    assert second.masked_text == first.masked_text
    assert second.hits == []


def test_text_that_already_contains_a_literal_placeholder_token_is_left_alone():
    result = apply_privacy_gate("Already redacted: [EMAIL_1] on file.")
    assert result.masked_text == "Already redacted: [EMAIL_1] on file."
    assert result.hits == []


def test_plain_policy_text_with_no_pii_produces_no_hits_and_unchanged_text():
    text = "Refunds over 15% require manager sign-off. Orders over $50 ship free."
    result = apply_privacy_gate(text)
    assert result.masked_text == text
    assert result.hits == []
    assert len(result.mapping.value_to_placeholder) == 0


def test_the_same_value_seen_across_layers_keeps_one_consistent_placeholder():
    # "Acme Corporation" appears twice; both mentions must collapse onto
    # ONE placeholder, not mint a second one for the repeat -- verified
    # against the placeholder itself, not a hardcoded kind label, since
    # spaCy is not guaranteed to assign the identical entity label to
    # every repeated mention of the same string within one document (an
    # empirically confirmed quirk on some inputs -- whichever label the
    # FIRST mention gets is the one the shared registry locks in for every
    # later mention of that exact value, by design: see registry.py's own
    # "keyed on the raw value alone" docstring). Nothing leaks either way.
    text = "Acme Corporation shipped the order. Acme Corporation also issued the refund."
    result = apply_privacy_gate(text)
    org_hits = [hit for hit in result.hits if hit.value == "Acme Corporation"]
    assert len(org_hits) == 2
    assert org_hits[0].placeholder == org_hits[1].placeholder
    assert "Acme Corporation" not in result.masked_text

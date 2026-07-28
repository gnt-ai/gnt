"""Layer 2 (NER) tests, run directly against run_ner_layer so these don't
depend on layer 1's output. Ported from
apps/cli/test/privacy-gate/ner.test.ts, adapted for the library swap
(compromise -> spaCy en_core_web_md -- see layer2_ner.py's module
docstring for why). Same coverage intent as the CLI suite (person, org,
place, repeated-name consistency, person+org+place together, "does not
re-tag an already-claimed placeholder span") -- exact literal outputs
differ where spaCy's actual (verified) entity boundaries differ from
compromise's, which is expected given the library swap and is exactly why
this file asserts against spaCy's real, tested output rather than
transliterating the JS suite's literal string expectations.
"""

from gnt.pipeline.privacy_gate.layer2_ner import run_ner_layer
from gnt.pipeline.privacy_gate.registry import PlaceholderRegistry


def run(text: str):
    return run_ner_layer(text, PlaceholderRegistry())


def test_masks_a_full_person_name():
    result = run("Please contact Jane Smith about the outstanding invoice.")
    assert result.text == "Please contact [PERSON_1] about the outstanding invoice."


def test_masks_an_organization_name():
    result = run("This handbook belongs to Acme Corporation.")
    assert "[ORG_1]" in result.text
    assert "Acme Corporation" not in result.text


def test_masks_a_place_name_without_dragging_in_trailing_sentence_punctuation():
    result = run("Our headquarters is in San Francisco. Remote staff work from home.")
    assert result.text == "Our headquarters is in [ADDRESS_1]. Remote staff work from home."


def test_masks_a_repeated_full_name_with_the_same_placeholder_both_times():
    result = run("Jane Smith filed the ticket. Jane Smith later closed it.")
    assert result.text == "[PERSON_1] filed the ticket. [PERSON_1] later closed it."
    assert len([h for h in result.hits if h.kind == "PERSON"]) == 2


def test_masks_person_org_and_place_together_in_one_pass():
    result = run("Please contact Jane Smith about the Acme Corporation handbook.")
    assert "[PERSON_1]" in result.text
    assert "[ORG_1]" in result.text
    assert "Jane Smith" not in result.text
    assert "Acme Corporation" not in result.text


def test_does_not_run_over_spans_layer_1_already_claimed_as_placeholders():
    # Simulates layer 1 having already masked an email in this sentence --
    # the NER layer must leave [EMAIL_1] alone rather than trying to tag it
    # as a person or org, and must not renumber it as, say, [ORG_2].
    result = run("Contact [EMAIL_1] about the Acme Corporation handbook.")
    assert "[EMAIL_1]" in result.text
    assert "[ORG_1]" in result.text
    assert result.hits[0].placeholder != "[EMAIL_1]"
    assert all(hit.placeholder != "[EMAIL_1]" for hit in result.hits)


def test_does_not_mask_a_plain_policy_sentence_with_no_names():
    # False-positive-avoidance is layer 1's own bar, extended here: NER
    # must not invent an entity out of ordinary sentence-initial
    # capitalization. (This is the specific case that ruled out
    # en_core_web_sm in favor of en_core_web_md -- see layer2_ner.py's
    # module docstring.)
    text = "Refunds over 15% require manager sign-off. Orders over $50 ship free within 3 days."
    result = run(text)
    assert result.text == text
    assert result.hits == []


# -- Known limitation: short all-caps acronyms get suppressed as ORG on
# purpose (_SHORT_ACRONYM_RE in layer2_ner.py) -- both directions of that
# documented tradeoff get an explicit test, not just a comment. -----------


def test_does_not_mask_a_bare_business_acronym_as_an_org():
    # Without the guard, spaCy (both en_core_web_sm and en_core_web_md,
    # confirmed empirically) tags "SSN" as ORG here -- which would mask
    # the WORD "SSN" itself on every rule that mentions the concept, a
    # much higher-frequency problem than the CLI's own accepted NER quirks.
    result = run("Her SSN is a nine digit number.")
    assert [h for h in result.hits if h.kind == "ORG"] == []
    assert "SSN" in result.text


def test_does_not_mask_common_technical_and_business_acronyms_as_orgs():
    for text in (
        "Rotate the API key every 90 days.",
        "Check the IP address before allowing access.",
        "The CFO signs off on all wire transfers.",
    ):
        result = run(text)
        assert [h for h in result.hits if h.kind == "ORG"] == [], text


def test_accepted_tradeoff_a_bare_short_company_acronym_is_not_masked_either():
    # The other side of the same guard: a real company acronym mentioned
    # bare also survives unmasked. Deliberately accepted -- see
    # layer2_ner.py's "known limitations" writeup for why a missed bare
    # company acronym is a materially lower-risk miss than reliably
    # mangling ordinary policy prose full of business/technical acronyms.
    result = run("Contact IBM support for hardware issues.")
    assert [h for h in result.hits if h.kind == "ORG"] == []
    assert "IBM" in result.text


def test_a_multi_word_org_name_is_still_masked_even_though_it_contains_capitals():
    # The acronym guard only suppresses a SINGLE all-caps token -- it must
    # not accidentally swallow ordinary multi-word org names.
    result = run("This handbook belongs to Acme Corporation.")
    assert "[ORG_1]" in result.text

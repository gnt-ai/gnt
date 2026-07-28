"""Layer 2b (policy-vs-personal amount classification) tests. Ported from
apps/cli/test/privacy-gate/amounts.test.ts -- two sections, same as that
suite: the classifier run directly via run_amounts_layer (isolated from
NER, so it's clear what the classifier itself does with an
already-placeholdered/possessive-marked input), then end to end through
apply_privacy_gate (so NER's actual output feeds the classifier the way it
really would in production).

Per the task's own framing, over-masking a policy sentence is the worse
mistake (it makes an extracted rule useless), so the "keep this" section
below is the one that has to hold up across the most phrasings -- same
priority the CLI suite's own comment gives it.
"""

from gnt.pipeline.privacy_gate import apply_privacy_gate
from gnt.pipeline.privacy_gate.layer2b_amounts import run_amounts_layer
from gnt.pipeline.privacy_gate.registry import PlaceholderRegistry


def run(text: str):
    return run_amounts_layer(text, PlaceholderRegistry())


# -- Layer-level: policy values must survive (no entity/possessive nearby) --


def test_does_not_mask_a_bare_dollar_threshold_with_no_entity_reference():
    result = run("Orders over $50 get free shipping.")
    assert result.text == "Orders over $50 get free shipping."
    assert result.hits == []


def test_does_not_mask_a_bare_percentage_threshold_with_no_entity_reference():
    result = run("Refunds over 15% require manager sign-off.")
    assert result.text == "Refunds over 15% require manager sign-off."
    assert result.hits == []


def test_does_not_mask_a_dollar_threshold_phrased_as_under():
    result = run("Any purchase under $25 doesn't need a receipt.")
    assert result.text == "Any purchase under $25 doesn't need a receipt."
    assert result.hits == []


def test_does_not_mask_a_dollar_threshold_phrased_as_a_flat_statement():
    result = run("The threshold for automatic approval is $1,000.")
    assert result.text == "The threshold for automatic approval is $1,000."
    assert result.hits == []


def test_does_not_mask_a_percentage_threshold_phrased_with_above():
    result = run("Discounts above 20% need approval from a manager.")
    assert result.text == "Discounts above 20% need approval from a manager."
    assert result.hits == []


def test_does_not_mask_a_dollar_threshold_phrased_as_a_conditional_clause():
    result = run("If the refund exceeds $200, escalate to a supervisor.")
    assert result.text == "If the refund exceeds $200, escalate to a supervisor."
    assert result.hits == []


def test_does_not_mask_multiple_policy_thresholds_in_the_same_sentence():
    text = "Refunds over 15% require manager sign-off. Orders over $50 ship free within 3 days."
    result = run(text)
    assert result.text == text
    assert result.hits == []


# -- Layer-level: personal values must be masked --


def test_masks_a_dollar_amount_preceded_by_a_possessive_noun():
    result = run("The customer's balance is $50,000.")
    assert result.text == "The customer's balance is [AMOUNT_1]."
    assert result.hits[0].kind == "AMOUNT"
    assert result.hits[0].value == "$50,000"


def test_masks_a_dollar_amount_preceded_by_a_possessive_pronoun():
    result = run("Her outstanding balance is $312.50.")
    assert result.text == "Her outstanding balance is [AMOUNT_1]."


def test_masks_a_dollar_amount_adjacent_to_an_already_masked_person_placeholder():
    result = run("[PERSON_1] owes $89.99 on the account.")
    assert result.text == "[PERSON_1] owes [AMOUNT_1] on the account."


def test_masks_a_dollar_amount_that_comes_before_the_person_placeholder_that_owns_it():
    result = run("$4,392.17 was charged to [PERSON_1].")
    assert result.text == "[AMOUNT_1] was charged to [PERSON_1]."


def test_masks_a_dollar_amount_adjacent_to_an_already_masked_org_placeholder():
    result = run("[ORG_1] account balance is $12,000.")
    assert result.text == "[ORG_1] account balance is [AMOUNT_1]."


def test_masks_a_personal_percentage_preceded_by_a_possessive_pronoun():
    result = run("Her commission is 12% this quarter.")
    assert result.text == "Her commission is [AMOUNT_1] this quarter."


def test_does_not_misread_a_non_possessive_s_contraction_as_a_possessive_marker():
    # "it's" is "it is", not a possessive -- must not trigger a false mask.
    result = run("Escalate if it's over $50.")
    assert result.text == "Escalate if it's over $50."
    assert result.hits == []


# -- Layer-level: time-period possessives are not a personal-ownership
# signal -- a calendar noun in possessive form ("this quarter's", "today's")
# matches the same bare "'s" shape as "customer's" but can never be the
# specific person/org a figure personally belongs to. Regression coverage
# for the false positive a tester reported: an ordinary policy threshold
# ("this quarter's revenue target is $50,000") was coming out masked. -----


def test_does_not_mask_a_dollar_threshold_after_a_quarter_possessive():
    result = run("This quarter's revenue target is $50,000.")
    assert result.text == "This quarter's revenue target is $50,000."
    assert result.hits == []


def test_does_not_mask_a_percentage_threshold_after_a_year_possessive():
    result = run("Last year's discount rate was 15%.")
    assert result.text == "Last year's discount rate was 15%."
    assert result.hits == []


def test_does_not_mask_a_dollar_threshold_after_a_today_possessive():
    result = run("Today's exchange rate adds 3% to the total.")
    assert result.text == "Today's exchange rate adds 3% to the total."
    assert result.hits == []


def test_still_masks_a_personal_amount_next_to_an_unrelated_time_possessive():
    # A real possessive owner elsewhere in the window must still win --
    # this fix only suppresses the time-noun match, not the whole check.
    result = run("This quarter's numbers are in: Jane's bonus was $4,000.")
    assert result.text == "This quarter's numbers are in: Jane's bonus was [AMOUNT_1]."
    assert result.hits[0].value == "$4,000"


def test_does_not_mask_a_dollar_threshold_after_a_yesterday_possessive():
    result = run("Yesterday's closing price was $50.")
    assert result.text == "Yesterday's closing price was $50."
    assert result.hits == []


def test_does_not_mask_a_percentage_threshold_after_a_tomorrow_possessive():
    result = run("Tomorrow's rate goes up 5%.")
    assert result.text == "Tomorrow's rate goes up 5%."
    assert result.hits == []


def test_does_not_mask_a_dollar_threshold_after_a_week_possessive():
    result = run("This week's total was $12,000.")
    assert result.text == "This week's total was $12,000."
    assert result.hits == []


def test_does_not_mask_a_percentage_threshold_after_a_month_possessive():
    result = run("Last month's growth was 8%.")
    assert result.text == "Last month's growth was 8%."
    assert result.hits == []


def test_masks_the_surname_day_as_a_real_possessive_owner():
    # "day's" is deliberately NOT in the time-noun exclusion set -- it
    # collides with the common surname "Day". Without this exclusion,
    # "Robert Day's severance was $120,000" would go unmasked, a real
    # false negative on an actual personal figure.
    result = run("Robert Day's severance was $120,000.")
    assert result.text == "Robert Day's severance was [AMOUNT_1]."
    assert result.hits[0].value == "$120,000"


# -- Layer-level: documented adversarial/over-masking cases -- both are
# real false positives the module accepts on purpose -- see the "known
# false-positive failure mode" writeup in layer2b_amounts.py. A fixed-
# radius text window can't tell a possessive or a name that's actually
# about the figure apart from one that just happens to share a sentence
# with it. Asserted explicitly, same as the CLI suite's own precedent for
# documenting a gap rather than hiding it. -----------------------------


def test_adversarial_a_generic_possessive_subject_still_masks_a_nearby_policy_shaped_figure():
    result = run("The customer's order must be over $50 to qualify for free shipping.")
    assert result.text == "The customer's order must be over [AMOUNT_1] to qualify for free shipping."


def test_adversarial_a_named_speaker_earlier_in_the_sentence_masks_an_unrelated_policy_figure():
    result = run("[PERSON_1] mentioned that orders over $50 always ship free.")
    assert result.text == "[PERSON_1] mentioned that orders over [AMOUNT_1] always ship free."


# -- End-to-end through apply_privacy_gate --


def test_e2e_masks_a_customers_invoice_amount_tied_to_a_name_via_possessive_ner():
    result = apply_privacy_gate("Jane's invoice was $4,392.17.")
    assert "[PERSON_1]" in result.masked_text
    assert "[AMOUNT_1]" in result.masked_text
    assert "4,392.17" not in result.masked_text
    assert result.mapping.placeholder_to_value["[AMOUNT_1]"] == "$4,392.17"


def test_e2e_masks_an_orgs_account_balance_via_possessive_ner():
    result = apply_privacy_gate("Acme Corporation's account balance is $12,000.")
    assert result.masked_text == "[ORG_1] account balance is [AMOUNT_1]."


def test_e2e_keeps_a_plain_policy_sentence_with_a_percentage_and_a_dollar_threshold_untouched():
    text = "Refunds over 15% require manager sign-off. Orders over $50 ship free within 3 days."
    result = apply_privacy_gate(text)
    assert result.masked_text == text
    assert result.hits == []


def test_e2e_a_sentence_with_both_a_policy_threshold_and_a_personal_amount_masks_only_the_personal_one():
    text = "Orders over $50 ship free. The customer's balance is $50,000."
    result = apply_privacy_gate(text)
    assert result.masked_text == "Orders over $50 ship free. The customer's balance is [AMOUNT_1]."
    assert len(result.hits) == 1
    assert result.hits[0].kind == "AMOUNT"
    assert result.hits[0].value == "$50,000"


def test_e2e_the_mapping_reverses_exactly_for_a_masked_amount():
    result = apply_privacy_gate("The customer's balance is $50,000.")
    placeholder = result.mapping.value_to_placeholder["$50,000"]
    assert placeholder == "[AMOUNT_1]"
    assert result.mapping.placeholder_to_value[placeholder] == "$50,000"


def test_e2e_running_the_gate_twice_does_not_re_mask_an_already_masked_amount():
    first = apply_privacy_gate("Jane's invoice was $4,392.17.")
    second = apply_privacy_gate(first.masked_text)
    assert second.masked_text == first.masked_text
    assert second.hits == []

"""Layer 1 (deterministic detectors) tests. Ported from
apps/cli/test/privacy-gate/deterministic.test.ts -- same cases (both the
true positives and the false-positive-avoidance cases, per that suite's
own bar: layer 1 must not be trigger-happy on plain numbers and
percentages even though full policy-vs-PII discrimination is layer 2b's
job, not this layer's). Fixture values are the exact ones the CLI suite
uses; only the language changed.
"""

from gnt.pipeline.privacy_gate.layer1_deterministic import run_deterministic_layer
from gnt.pipeline.privacy_gate.registry import PlaceholderRegistry


def run(text: str):
    return run_deterministic_layer(text, PlaceholderRegistry())


# -- API keys / tokens --


def test_masks_a_vendor_prefixed_openai_anthropic_style_secret_key():
    result = run("key: sk-proj-abc123DEF456ghi789JKL012")  # gitleaks:allow
    assert "[KEY_1]" in result.text
    assert len(result.hits) == 1
    assert result.hits[0].kind == "KEY"


def test_masks_a_github_classic_personal_access_token():
    result = run("token=ghp_16C7e42F292c6912E7710c838347Ae178B4a")  # gitleaks:allow
    assert result.text == "token=[KEY_1]"


def test_masks_a_github_fine_grained_pat():
    result = run(
        "github_pat_11AAAAAAA0aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    )
    assert "[KEY_1]" in result.text


def test_masks_a_slack_bot_token():
    result = run("SLACK_TOKEN=xoxb-1234567890-abcdefghijklmnop")  # gitleaks:allow
    assert "[KEY_1]" in result.text


def test_masks_an_aws_access_key_id():
    result = run("aws_access_key_id = AKIAIOSFODNN7EXAMPLE")
    assert "[KEY_1]" in result.text


def test_masks_a_generic_high_entropy_token_with_no_known_vendor_prefix():
    result = run("internal token: 7f9a8b3c1d2e4f5a6b7c8d9e0f1a2b3c4d5e6f7a")  # gitleaks:allow
    assert "[KEY_1]" in result.text


def test_does_not_mask_an_ordinary_long_capitalized_phrase_as_a_key():
    result = run("the quarterly engineering all hands retrospective document")
    assert [h for h in result.hits if h.kind == "KEY"] == []


def test_does_not_mask_a_long_hyphenated_slug_with_no_digits_as_a_key():
    result = run("see the customer-facing-refund-policy-overview page")
    assert [h for h in result.hits if h.kind == "KEY"] == []


# -- Credit cards (Luhn) --


def test_masks_a_luhn_valid_card_number_with_space_grouping():
    result = run("Card 4242 4242 4242 4242 was charged.")
    assert result.text == "Card [CREDIT_CARD_1] was charged."


def test_masks_a_luhn_valid_card_number_with_dash_grouping():
    result = run("4242-4242-4242-4242")
    assert result.text == "[CREDIT_CARD_1]"


def test_does_not_mask_a_16_digit_run_that_fails_the_luhn_checksum():
    result = run("reference number 1234 5678 9012 3456 on file")
    assert [h for h in result.hits if h.kind == "CREDIT_CARD"] == []


def test_does_not_mask_a_plain_dollar_amount():
    result = run("Orders over $50 get free shipping.")
    assert result.text == "Orders over $50 get free shipping."


# -- SSNs --


def test_masks_a_valid_shaped_ssn():
    result = run("SSN: 078-05-1120")
    assert result.text == "SSN: [SSN_1]"


def test_does_not_mask_an_ssn_with_the_invalid_000_area_number():
    result = run("ref 000-12-3456")
    assert [h for h in result.hits if h.kind == "SSN"] == []


def test_does_not_mask_an_ssn_with_the_invalid_666_area_number():
    result = run("ref 666-12-3456")
    assert [h for h in result.hits if h.kind == "SSN"] == []


def test_does_not_mask_an_ssn_with_an_area_number_in_the_reserved_900_999_itin_range():
    result = run("ref 912-12-3456")
    assert [h for h in result.hits if h.kind == "SSN"] == []


def test_does_not_mask_an_ssn_shaped_number_with_a_00_group():
    result = run("ref 123-00-4567")
    assert [h for h in result.hits if h.kind == "SSN"] == []


def test_does_not_mask_an_ssn_shaped_number_with_a_0000_serial():
    result = run("ref 123-45-0000")
    assert [h for h in result.hits if h.kind == "SSN"] == []


def test_does_not_mask_a_plain_percentage_as_an_ssn_or_a_card():
    result = run("Policy: discounts over 15% need sign-off.")
    assert result.text == "Policy: discounts over 15% need sign-off."


# -- Emails --


def test_masks_a_normal_email_address():
    result = run("Contact jane.smith+billing@acme.co.uk for details.")
    assert result.text == "Contact [EMAIL_1] for details."


def test_masks_the_same_email_the_same_way_every_time_it_appears():
    result = run("From: jane@acme.com. Reply to jane@acme.com only.")
    assert result.text == "From: [EMAIL_1]. Reply to [EMAIL_1] only."
    assert len([h for h in result.hits if h.kind == "EMAIL"]) == 2


# -- Phone numbers --


def test_masks_a_us_phone_number_with_dashes():
    result = run("Call 555-123-4567 for support.")
    assert result.text == "Call [PHONE_1] for support."


def test_masks_a_us_phone_number_with_parens_and_a_leading_country_code():
    result = run("+1 (555) 123-4567")
    assert result.text == "[PHONE_1]"


def test_masks_an_international_phone_number():
    result = run("+44 20 7946 0958")
    assert result.text == "[PHONE_1]"


def test_does_not_mask_a_bare_short_number_as_a_phone_number():
    result = run("Orders over $50 get free shipping.")
    assert [h for h in result.hits if h.kind == "PHONE"] == []


# -- IPs --


def test_masks_a_public_ipv4_address():
    result = run("DNS is 8.8.8.8")
    assert result.text == "DNS is [IP_1]"


def test_masks_a_private_ipv4_address_the_same_as_a_public_one():
    # Private/loopback ranges get masked too -- see the reasoning directly
    # above _detect_ips in layer1_deterministic.py. Not PII, but this gate
    # runs before any of this content is stored, so internal network
    # topology is treated as sensitive-by-default: a placeholder costs
    # nothing, under-masking it is a real disclosure.
    result = run("internal host is 10.0.0.5")
    assert result.text == "internal host is [IP_1]"


def test_masks_a_loopback_address():
    result = run("bound to 127.0.0.1")
    assert result.text == "bound to [IP_1]"


def test_does_not_mask_an_invalid_ipv4_shaped_number():
    result = run("version 999.999.999.999 does not exist")
    assert [h for h in result.hits if h.kind == "IP"] == []


def test_masks_a_full_ipv6_address():
    result = run("route to 2001:0db8:85a3:0000:0000:8a2e:0370:7334")
    assert result.text == "route to [IP_1]"


def test_masks_a_compressed_ipv6_loopback_address():
    result = run("bound to ::1")
    assert result.text == "bound to [IP_1]"


# -- Cross-cutting --


def test_assigns_a_distinct_placeholder_per_distinct_value_within_a_kind():
    result = run("Emails: a@example.com and b@example.com.")
    assert result.text == "Emails: [EMAIL_1] and [EMAIL_2]."


def test_a_realistic_policy_sentence_with_numbers_and_percentages_is_left_untouched():
    text = "Refunds over 15% require manager sign-off. Orders over $50 ship free within 3 days."
    result = run(text)
    assert result.text == text
    assert result.hits == []

"""render_rule_markdown is what a human reviewing a PR actually reads —
this is a pure unit test (no I/O) proving the frontmatter/body split is
clean and round-trips, and that body never leaks into frontmatter (the
whole point of a real git file being readable)."""

from gnt.github.render import parse_rule_markdown, render_rule_markdown

_RULE = {
    "title": "Refund window",
    "body": "Refunds are honored within 30 days of purchase.",
    "status": "pending_merge",
    "confidence": 0.82,
    "owner_user_id": "user_abc123",
    "source_citations": [{"source_type": "slack", "source_id": "C123", "permalink": None, "captured_at": None}],
    "source": "Slack thread with the ops team, 2026-07-10",
    "tags": ["billing", "refunds"],
    "last_validated_at": None,
    "version": 2,
    "superseded_by": None,
    "previous_version_id": "rules/11111111-1111-1111-1111-111111111111",
    "approved_by": None,
    "approved_at": None,
    "created_at": "2026-07-14T00:00:00Z",
    "pr_number": 42,
    "pr_url": "https://github.com/acme/rules/pull/42",
}


def test_render_starts_with_a_frontmatter_fence():
    rendered = render_rule_markdown(_RULE)
    assert rendered.startswith("---\n")


def test_body_is_not_duplicated_into_frontmatter():
    rendered = render_rule_markdown(_RULE)
    frontmatter, _ = parse_rule_markdown(rendered)
    assert "body" not in frontmatter


def test_round_trips_every_frontmatter_field_and_the_body():
    rendered = render_rule_markdown(_RULE)
    frontmatter, body = parse_rule_markdown(rendered)

    assert body == _RULE["body"]
    assert frontmatter["title"] == _RULE["title"]
    assert frontmatter["status"] == _RULE["status"]
    assert frontmatter["confidence"] == _RULE["confidence"]
    assert frontmatter["owner_id"] == _RULE["owner_user_id"]
    assert frontmatter["source_citations"] == _RULE["source_citations"]
    assert frontmatter["source"] == _RULE["source"]
    assert frontmatter["tags"] == _RULE["tags"]
    assert frontmatter["version"] == _RULE["version"]
    assert frontmatter["previous_version_id"] == _RULE["previous_version_id"]
    assert frontmatter["pr_number"] == _RULE["pr_number"]
    assert frontmatter["pr_url"] == _RULE["pr_url"]


def test_null_fields_round_trip_as_none_not_the_string_none():
    rendered = render_rule_markdown(_RULE)
    frontmatter, _ = parse_rule_markdown(rendered)
    assert frontmatter["superseded_by"] is None
    assert frontmatter["approved_by"] is None
    assert frontmatter["last_validated_at"] is None


def test_missing_pr_fields_default_to_none():
    rule = {k: v for k, v in _RULE.items() if k not in ("pr_number", "pr_url")}
    rendered = render_rule_markdown(rule)
    frontmatter, _ = parse_rule_markdown(rendered)
    assert frontmatter["pr_number"] is None
    assert frontmatter["pr_url"] is None


def test_missing_source_defaults_to_none():
    # Rules created before this field existed won't have the key at all —
    # render_rule_markdown must not KeyError on them.
    rule = {k: v for k, v in _RULE.items() if k != "source"}
    rendered = render_rule_markdown(rule)
    frontmatter, _ = parse_rule_markdown(rendered)
    assert frontmatter["source"] is None

from collections import defaultdict
from typing import Any


def cluster_rules_by_tag(rules: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Git-native rules (apps/store) carry free-form tags, not a single
    domain column — group under the rule's first tag, or "general" for an
    untagged rule, so an untagged pack still renders instead of vanishing."""
    tags: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for rule in rules:
        tag = rule["tags"][0] if rule.get("tags") else "general"
        tags[tag].append(rule)
    return dict(sorted(tags.items()))

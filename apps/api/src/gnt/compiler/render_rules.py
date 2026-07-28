from typing import Any


def render_index(rule_tags: list[str], version: int) -> str:
    lines = [
        "---",
        "name: brain-index",
        "description: Index of all approved rule tags for this organization",
        f"version: {version}",
        "---",
        "",
        "# Rules Index",
        "",
        "Load a tag file when its subject is relevant to the current task.",
        "",
    ]
    for tag in rule_tags:
        lines.append(f"- [{tag}](skills/rules/{tag}/SKILL.md)")
    return "\n".join(lines)


def render_tag_rules_skill(tag: str, version: int, rules: list[dict[str, Any]]) -> str:
    """Renders one tag's worth of approved git-native rules. Each rule's
    body is whatever markdown a human last merged in its PR — see
    docs/migration/GIT_NATIVE_DONE.md's Phase 4 notes on why the merged
    file's content, not the originally-proposed draft, is authoritative."""
    lines = [
        "---",
        f"name: rules-{tag}",
        f"description: Approved rules for {tag.replace('_', ' ')}",
        f"version: {version}",
        "---",
        "",
        f"# {tag.replace('_', ' ').title()} — Rules",
        "",
        "Every rule below was approved by a human merging a pull request against "
        "the org's rules repo. Do not infer additional rules beyond what is stated here.",
        "",
    ]
    for rule in rules:
        lines.append(f"## {rule['title']}")
        lines.append("")
        lines.append(rule["body"])
        lines.append("")
        lines.append(f"- **Confidence:** {rule['confidence']:.2f}")
        if rule.get("prUrl"):
            lines.append(f"- **Approved via:** {rule['prUrl']}")
        lines.append("")
    return "\n".join(lines)

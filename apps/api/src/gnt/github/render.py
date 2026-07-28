import yaml

_FENCE = "---"


def render_rule_markdown(rule: dict) -> str:
    """Renders a rule (the same dict shape routers/rules.py's _serialize
    returns) as a markdown file with YAML frontmatter — one file per rule,
    at rules/<bare-rule-id>.md, the same slug shape the engine-pages path
    already uses (see routers/rules.py's _slug/_bare_id), so a git-synced
    page and a direct-write engine page share one version-chain regardless
    of which path produced them.

    Frontmatter carries every field except `body` — body is the whole
    point of a real git file being "readable, greppable": burying it in
    frontmatter too, the way the engine-pages path's compiled_truth field
    does, would defeat that for something a human is meant to read as a
    normal markdown file."""
    frontmatter = {
        "title": rule["title"],
        "status": rule["status"],
        "confidence": rule["confidence"],
        "owner_id": rule["owner_user_id"],
        "source_citations": rule["source_citations"],
        "source": rule.get("source"),
        "tags": rule["tags"],
        "last_validated_at": rule["last_validated_at"],
        "version": rule["version"],
        "superseded_by": rule["superseded_by"],
        "previous_version_id": rule["previous_version_id"],
        "approved_by": rule["approved_by"],
        "approved_at": rule["approved_at"],
        "created_at": rule["created_at"],
        "pr_number": rule.get("pr_number"),
        "pr_url": rule.get("pr_url"),
    }
    yaml_block = yaml.safe_dump(frontmatter, sort_keys=False, allow_unicode=True).rstrip("\n")
    return f"{_FENCE}\n{yaml_block}\n{_FENCE}\n\n{rule['body']}\n"


def parse_rule_markdown(content: str) -> tuple[dict, str]:
    """Inverse of render_rule_markdown — returns (frontmatter, body). Used
    by tests to round-trip; not part of any request path (git-native reads
    happen through the engine's own sync/import, not this parser)."""
    if not content.startswith(f"{_FENCE}\n"):
        raise ValueError("missing frontmatter fence")
    _, _, rest = content.partition(f"{_FENCE}\n")
    yaml_block, _, body = rest.partition(f"\n{_FENCE}\n")
    frontmatter = yaml.safe_load(yaml_block) or {}
    return frontmatter, body.lstrip("\n").rstrip("\n")

---
name: gnt-check-action
description: Check a side-effectful action against this organization's approved gnt rules before taking it, and stop on a blocked or needs_human verdict.
---

# Check actions with gnt-brain

Cursor has gnt-brain available as an MCP server named `gnt-brain`. It exposes `check_action`,
`search_rules`, `get_rule`, `list_skill_packs`, and `get_skill_pack`.

## Before taking an action

Before sending a message, moving money, deleting data, or taking another action that is hard to
undo, call `check_action` with a plain-English description of the exact action.

The client or executor must require an `allowed` verdict for the same recipient, amount, target,
and scope. Run a new check if any detail changes.

* If the verdict is `allowed`, proceed.
* If the verdict is `blocked`, stop. Explain why and cite the returned rule.
* If the verdict is `needs_human`, stop and ask a human to approve the action.

A missing, failed, expired, or unclear verdict is not permission to continue.

## Before answering a policy question

Use `search_rules` to find approved rules and `get_rule` to retrieve the full text of a rule.
Use `list_skill_packs` and `get_skill_pack` for compiled company context. Do not infer policy
from drafts, rules in review, rejected rules, or deprecated rules.

## When a human is needed

Do not retry with a softer description, route around the check, or decide for the human. Show
the proposed action and gnt-brain's reason, then wait for the decision.

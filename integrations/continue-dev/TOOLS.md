---
name: gnt action checks
alwaysApply: true
---

# gnt-brain tools

Use gnt-brain's `check_action`, `search_rules`, `get_rule`, `list_skill_packs`, and
`get_skill_pack` through Continue's MCP connection in Agent mode.

## Before taking an action

Before sending a message, moving money, deleting data, or taking another action that is hard
to undo, call `check_action` with a plain-English description of the exact action, including
the recipient, amount, target, and scope where applicable.

- On `allowed`, proceed only with the action that was checked.
- On `blocked`, stop, explain the reason, and cite the returned rule.
- On `needs_human`, stop and ask a human to decide.

A missing, failed, expired, or unclear verdict is not permission. If the action changes, run
a new check. This instruction does not enforce a verdict itself; the client or executor must
gate side effects on an `allowed` result for the same action.

## Before answering a policy question

Use `search_rules` for approved organization rules and `get_rule` for their full text. Draft,
in-review, rejected, and deprecated rules are not policy. Use `list_skill_packs` and
`get_skill_pack` for compiled company context instead of guessing.

## When a human is needed

Show the proposed action and gnt-brain's reason, then wait. Do not soften the description,
route around the check, or choose a branch on the human's behalf.

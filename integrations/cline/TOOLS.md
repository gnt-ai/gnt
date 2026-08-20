# gnt-brain tools for Cline

This file is intended to be copied into a project's `.clinerules/` directory. The MCP connection
is configured separately; see [`CONNECT.md`](CONNECT.md).

gnt-brain exposes `check_action`, `search_rules`, `get_rule`, `list_skill_packs`, and
`get_skill_pack`.

## Before taking an action

Before sending a message, moving money, deleting data, or taking another action that is hard to
undo, call `check_action` with a plain-English description of the exact action.

This instruction does not enforce the decision by itself. The client or executor that performs
the side effect must require an `allowed` verdict for the same recipient, amount, target, and
scope. Run a new check if any of those details change.

- If the verdict is `allowed`, proceed with the action.
- If the verdict is `blocked`, stop. Explain why and cite the returned rule.
- If the verdict is `needs_human`, stop and ask a human to approve the action.

A missing, failed, expired, or unclear verdict is not permission to continue.

## Before answering a policy question

Use `search_rules` to find the organization's approved rules. Use `get_rule` when you need the
full text of one rule. Draft, in-review, rejected, and deprecated rules are not policy.

Use `list_skill_packs` and `get_skill_pack` for compiled company context instead of guessing.

## When a human is needed

Do not retry with a softer description, route around the check, or choose a branch for the human.
Show the proposed action and gnt-brain's reason, then wait for the decision.

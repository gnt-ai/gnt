# gnt-brain tools for OpenCode

This file is intended to be loaded through OpenCode's `instructions` configuration or merged into
a project's `AGENTS.md`. The MCP connection is configured separately; see
[`CONNECT.md`](CONNECT.md).

gnt-brain exposes `check_action`, `search_rules`, `get_rule`, `list_skill_packs`, and
`get_skill_pack`.

## Before taking an action

Before sending a message, moving money, deleting data, or taking another action that is hard to
undo, build one canonical snapshot containing every input that can change the side effect. Include
the operation, resource identifiers, destination, content or payload, options, permissions, and
any other relevant field in a deterministic order. Send that complete snapshot in the
`check_action` description; free-form context is not a substitute for an omitted field.

This instruction does not enforce the decision by itself. The client or executor must retain the
checked snapshot with the verdict, recreate the snapshot from the actual operation immediately
before execution, and require both an `allowed` verdict and an exact match. Run `check_action`
again whenever any side-effect-relevant field changes; never reuse approval for a different
snapshot.

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

---
name: gnt-check-action
description: Check a side-effectful action against this org's approved gnt rules before taking it, and stop on a blocked or needs_human verdict.
homepage: https://gntai.dev/docs
---

# gnt check_action

This workspace has gnt-brain connected as an MCP server (`gnt connect openclaw`, or the `gnt-brain` entry under `mcp.servers` in `openclaw.json`). It exposes five tools: `check_action`, `search_rules`, `get_rule`, `list_skill_packs`, `get_skill_pack`.

## Before you act

Before any action that sends a message, moves money, deletes data, or is otherwise hard to undo, first call the check_action tool with a plain-English description of what you are about to do.

- verdict "allowed": proceed.
- verdict "blocked": do not proceed. Tell the user why, citing the rule.
- verdict "needs_human": stop and ask a human to approve before acting.

Never treat a missing or unclear verdict as permission to act.

## Before you answer a policy question

Use `search_rules` for semantic search over this org's approved rules. Only rules with status == 'approved' are ever returned; draft, in-review, rejected, and deprecated rules never reach this tool. Use `get_rule` to fetch one by id. Use `list_skill_packs` and `get_skill_pack` to pull the compiled skill pack for company context instead of guessing at policy.

## On needs_human

Stop. Don't retry the call with a softer description, don't route around it, don't pick the safer-looking branch yourself. Surface the action and check_action's reason to the human and wait for them to decide.

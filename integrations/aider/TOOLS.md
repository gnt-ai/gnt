# gnt-brain tools

This file is intended to be loaded by Aider as a read-only conventions file (`read:` in `.aider.conf.yml`, or `aider --read TOOLS.md`), so it is in context for every session. Aider has no MCP client yet, so it cannot call these tools today — the contracts below are the working agreement for the repo in the meantime, and [`CONNECT.md`](CONNECT.md) explains the current state and the limits of this setup. In particular, `check_action` is always "unavailable" from Aider, so its fallback below is the operative rule: surface the action and let the user decide.

gnt-brain exposes five tools: `check_action`, `search_rules`, `get_rule`, `list_skill_packs`, and `get_skill_pack`.

## Before taking an action

Before any externally visible or hard-to-reverse action — sending a message or email, creating, updating, or deleting a record in an external system, running a destructive command — call `check_action` first, with a one-sentence `title`, the `system` (for example, `email`, `crm`, `billing`, `shell`), and a `payload` that carries the details a human reviewer would want: recipients, record ids, amounts, the exact text when there is one.

Obey the verdict:

- `allowed` — proceed.
- `blocked` — do not act. Tell the user which rule blocked the action and why.
- `needs_human` — stop and ask the user to decide. A human approves or denies in Slack or the PR, not in this chat.

If `check_action` is unavailable or errors, treat that as `needs_human`, not as permission. When in doubt about whether an action is in scope, check it — asking costs one call, guessing wrong costs a cleanup.

## Before answering a policy question

When the user asks what the rules say — or you need a rule yourself to plan the work — use `search_rules` with a natural-language query (for example, "discount approval thresholds") instead of answering from memory. Open the specific rule with `get_rule` before citing it. If the user asks for the org's standard way of doing something, `list_skill_packs` shows the available packs and `get_skill_pack` loads the one that matches.

## When a human is needed

A human's time is for judgment calls, not lookups: search first, read the rule, and only then escalate. When you do escalate, include the action you checked, the rule that matched, and the verdict — not a bare "can I do this?".

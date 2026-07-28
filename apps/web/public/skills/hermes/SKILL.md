---
name: gnt-check-action
description: Check side-effectful actions against your org's approved gnt rules first
version: 1.0.0
metadata:
  hermes:
    tags: [governance, policy, mcp, rules]
    category: governance
    requires_toolsets: [mcp]
---

# gnt: check actions before you take them

## When to use this

Before any action that sends a message, moves money, deletes data, or is
otherwise hard to undo, first call the check_action tool with a plain-
English description of what you are about to do.

That covers anything side-effectful: sending a message on someone's
behalf, issuing a refund or otherwise moving money, deleting or
overwriting data, or any other step that's hard to undo. It also applies
whenever you need this org's own policy or context instead of guessing:
use search_rules and the org's compiled skill packs first.

This only works once gnt's MCP server is connected (`gnt connect hermes`
from the customer's own terminal, on the gnt side) and its tools are
enabled in `~/.hermes/config.yaml` under `mcp_servers.gnt`.

## Quick reference

Hermes registers MCP-server tools as `mcp_<server>_<tool>` -- with the
server configured as `gnt`, that's:

| Call it as | When |
|---|---|
| `mcp_gnt_check_action(description, context=None)` | Right before any side-effectful step |
| `mcp_gnt_search_rules(query, tags=None, limit=10)` | You need to know this org's policy on something |
| `mcp_gnt_get_rule(rule_id)` | You already have a rule id and need its full body |
| `mcp_gnt_list_skill_packs()` | You want to see what compiled context this org has |
| `mcp_gnt_get_skill_pack(pack_id)` | You want one compiled skill pack's contents |

## Procedure

1. Before calling any tool that sends a message, moves money, deletes
   data, or is otherwise hard to undo, call `mcp_gnt_check_action` with a
   plain-English description of the action you're about to take (and
   `context` if you have relevant detail beyond the description).
2. `check_action` checks the described action against this org's approved
   rules before you take it, and returns a verdict ("allowed", "blocked",
   or "needs_human") with the governing rule(s) cited and a one-line
   reason. It's conservative by design: no covering rule, a retrieval
   failure, or an unclear call all come back as "needs_human", never a
   guessed "allowed" or "blocked".
3. Branch on the verdict:
   - verdict "allowed": proceed.
   - verdict "blocked": do not proceed. Tell the user why, citing the rule.
   - verdict "needs_human": stop and ask a human to approve before acting.
4. Never treat a missing or unclear verdict as permission to act.

For anything that isn't itself the side-effectful step -- background on
how this org handles something, a policy question, prior context --
reach for `mcp_gnt_search_rules` or the compiled skill packs
(`mcp_gnt_list_skill_packs` / `mcp_gnt_get_skill_pack`) instead of
guessing. `search_rules` only ever returns rules with `status ==
"approved"`; draft, in-review, rejected, and deprecated rules never reach
it, so an empty result means nothing approved covers the question, not
that it's safe to proceed.

## Pitfalls

- Don't call the bare tool name (`check_action`) -- Hermes exposes it
  through the MCP tool-name prefix as `mcp_gnt_check_action`. If it's
  missing, run `/reload-mcp` or ask which MCP-backed tools are currently
  available before assuming gnt isn't connected.
- A `needs_human` verdict is not a soft warning -- stop and surface it to
  the human the same as a hard `blocked`.
- Don't paraphrase a `blocked` reason into something softer when telling
  the user -- cite the rule as returned.

## Verification

A real `allowed` verdict always comes with `cited_rules` and a nonzero
`rules_retrieved` -- if you ever see `verdict: "allowed"` with an empty
`cited_rules`, treat that the same as `needs_human` rather than
proceeding: nothing actually backed the decision.

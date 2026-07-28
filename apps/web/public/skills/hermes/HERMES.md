# Working with gnt

This project's actions are governed by rules stored in gnt. Retrieval
tells you what the policy is; check_action stops you from breaking it.

Before any action that sends a message, moves money, deletes data, or is
otherwise hard to undo, first call the check_action tool with a plain-
English description of what you are about to do.

- verdict "allowed": proceed.
- verdict "blocked": do not proceed. Tell the user why, citing the rule.
- verdict "needs_human": stop and ask a human to approve before acting.

Never treat a missing or unclear verdict as permission to act.

Use search_rules and this org's compiled skill packs (list_skill_packs /
get_skill_pack) for company context before guessing -- search_rules only
ever returns rules with status == "approved".

Hermes registers these through its MCP tool-name prefix: if the gnt MCP
server is configured as `gnt` in `~/.hermes/config.yaml`, call them as
`mcp_gnt_check_action`, `mcp_gnt_search_rules`, `mcp_gnt_get_rule`,
`mcp_gnt_list_skill_packs`, and `mcp_gnt_get_skill_pack`.

See the gnt-check-action skill for the full procedure.

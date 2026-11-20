# Connecting Continue to gnt-brain

gnt-brain exposes `check_action`, `search_rules`, `get_rule`, `list_skill_packs`, and
`get_skill_pack`. Continue uses MCP tools in **Agent mode**, with a model that supports tool
calling. Connecting the server makes its tools available; install the rule below to tell the
agent when to use them. See also the [general MCP client guide](../../apps/docs/pages/docs/mcp-clients.mdx).

## Configure the server

Configuration checked on 2026-09-09 against Continue's [MCP guide](https://docs.continue.dev/customize/deep-dives/mcp)
and [config.yaml reference](https://docs.continue.dev/reference#mcpservers).

Open your local configuration through the agent selector's gear icon in Continue. Merge this
entry into its `mcpServers` list, preserving the existing metadata, models, and other servers:

```yaml
mcpServers:
  - name: gnt-brain
    type: streamable-http
    url: https://api.gntai.dev/mcp/
    requestOptions:
      headers:
        Authorization: "Bearer ${{ secrets.GNT_MCP_KEY }}"
```

This is a fragment for an existing `config.yaml`, not a complete agent configuration. Keep the
trailing slash in the endpoint. Continue's remote HTTP headers belong under `requestOptions`.

Run `gnt keys create` after logging in to gnt. It displays the new MCP key once. Put that value
in your local `~/.continue/.env` (`$HOME\.continue\.env` on Windows):

```dotenv
GNT_MCP_KEY=gnt_live_REPLACE_WITH_YOUR_KEY
```

Continue's [local secrets documentation](https://docs.continue.dev/faqs#managing-local-secrets-and-environment-variables)
describes the `${{ secrets.NAME }}` syntax and `.env` lookup. Keep the actual key out of the
YAML, project files, chat, and logs. The `.env` file still contains plaintext: restrict access
and keep it outside version control. `gnt keys list` cannot recover a lost secret; create a new
key or use `gnt keys rotate <id>` instead. Reload the editor after changing local secrets.

## Install the action-check rule

Copy [TOOLS.md](TOOLS.md) to `.continue/rules/gnt-check-action.md` in the project you will work
on, creating `.continue/rules` if necessary. Preserve any existing rule at that destination.
The included frontmatter sets `alwaysApply: true`, following Continue's
[rules documentation](https://docs.continue.dev/customize/deep-dives/rules). Check Continue's
rules toolbar to confirm the rule is loaded. Rules do not apply to autocomplete or Apply.

## Verify before use

1. Select Agent mode and check that gnt-brain's five tools are available. If not, check the
   configuration for errors, secret lookup, and the selected model's tool-calling support.
2. In a test organization, ask the agent to check a proposed action covered by a blocking
   rule, without executing it. Confirm it calls `check_action`, reports `blocked`, and stops.
3. Check an action that returns `needs_human`. Confirm it asks for a human decision instead
   of treating the absence of an applicable rule as approval.

Keep real messaging, payment, and deletion tools disconnected during these checks. A loaded
rule is instruction, not an execution gate: the component performing a side effect must
require an `allowed` verdict for the exact action. Configuration and policy instructions here
were checked against documentation; an authenticated Continue session was not exercised.

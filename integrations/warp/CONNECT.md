# Connecting Warp to gnt-brain

gnt-brain is gnt's rules-governance MCP server. Once Warp is connected, its Agent can use
`check_action`, `search_rules`, `get_rule`, `list_skill_packs`, and `get_skill_pack`.
The connection makes those tools available, but it does not require the Agent to use them. Load
[`TOOLS.md`](TOOLS.md) as a Warp project or global rule too. For the shared endpoint and key
background, see gnt's [generic MCP client guide](../../apps/docs/pages/docs/mcp-clients.mdx).

## Add the remote MCP server

This setup follows Warp's current [MCP documentation](https://docs.warp.dev/agents/capabilities/mcp/)
(checked 2026-08-30). Warp supports Streamable HTTP servers with custom headers.

Open **Settings > Agents > MCP servers**, click **+ Add**, and paste this configuration:

```json
{
  "mcpServers": {
    "gnt-brain": {
      "url": "https://api.gntai.dev/mcp/",
      "headers": {
        "Authorization": "Bearer <paste your gnt MCP key here>"
      }
    }
  }
}
```

Keep the trailing slash in the URL. The deployed server redirects `/mcp` to `/mcp/`, so this
points Warp at the final endpoint instead of relying on redirect handling.

Create a key with `gnt keys create`, or use an existing key that you stored securely. `gnt keys
list` shows key metadata and status, but it cannot recover the secret. If the value is lost, create
a new key or run `gnt keys rotate <id>`.

The Authorization header contains the key as a sensitive value. Do not put this configuration in
a project file, commit the key, paste it into logs, or share the server. Warp documents automatic
scrubbing for environment values when a server is shared, but does not make the same promise for
custom headers; do not rely on sharing to remove this key. If entering a key in a custom header is
outside your security policy, do not use this setup until gnt-brain supports an authentication flow
approved by your organization.

## Load the action policy

Warp automatically applies project rules from an uppercase `AGENTS.md`, as described in its
[Rules documentation](https://docs.warp.dev/agents/capabilities/rules/). Merge the contents of
[`TOOLS.md`](TOOLS.md) into the project's root `AGENTS.md`, preserving any existing instructions.
If the project already has `WARP.md`, update that file instead because Warp gives it precedence
over `AGENTS.md` in the same directory.

To apply the policy across projects, open **Settings > Agents > Knowledge > Manage Rules** and add
the contents of `TOOLS.md` as a Global Rule. Project rules are easier to review alongside the code;
use a global rule only when the same gnt-brain connection is intentionally available everywhere.

Neither the MCP connection nor the rule is an enforcement boundary. The client or executor that
performs a side effect must retain and compare the exact checked action as described in
`TOOLS.md`.

## Verify the connection

In **Settings > Agents > MCP servers**, start `gnt-brain` and confirm Warp lists all five tools.
If the server does not start, open **View Logs** and check the endpoint and Authorization header.
Remove credentials before sharing any log output.

Then run two behavior checks against non-production test rules:

1. Ask Warp to take an action covered by a blocking rule. It must call `check_action` and stop
   when the verdict is `blocked`.
2. Ask it to take an action with no approved rule. It must stop and ask a human for approval when
   the verdict is `needs_human`.

Do not connect these checks to a real payment, messaging, or deletion tool. A running server proves
that the MCP tools are reachable. The prompts check that Warp applies the rule, while executor-side
gating remains the final control.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| The server fails authentication | Re-enter the key in the Authorization header and confirm the value begins with `Bearer `. |
| The server is present but stopped | Start it from **Settings > Agents > MCP servers** and inspect **View Logs** if it stops again. |
| The tools are available but the policy is ignored | Confirm the project uses uppercase `AGENTS.md`, or update `WARP.md` if both files exist. |
| `check_action` returns `needs_human` | Stop and ask the human; do not retry with a softer description or route around the check. |

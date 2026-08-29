# Connecting OpenCode to gnt-brain

gnt-brain is gnt's rules-governance MCP server. Once OpenCode is connected, it can use
`check_action`, `search_rules`, `get_rule`, `list_skill_packs`, and `get_skill_pack`.
The MCP connection makes those tools available; load [`TOOLS.md`](TOOLS.md) as an OpenCode
instruction too so the agent knows when to use them. For the shared endpoint and key background,
see gnt's [generic MCP client guide](../../apps/docs/pages/docs/mcp-clients.mdx).

## Add the remote MCP server

This configuration follows OpenCode's current [MCP server documentation](https://opencode.ai/docs/mcp-servers)
(checked 2026-08-29). OpenCode merges global configuration from
`~/.config/opencode/opencode.json` with a project's `opencode.json`, so add the server to whichever
scope should have access to gnt-brain.

Add this entry to the existing top-level `mcp` object:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "gnt-brain": {
      "type": "remote",
      "url": "https://api.gntai.dev/mcp/",
      "enabled": true,
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:GNT_MCP_KEY}"
      }
    }
  }
}
```

Keep the trailing slash in the URL. The deployed server redirects `/mcp` to `/mcp/`, so this
points OpenCode at the final MCP endpoint instead of relying on redirect handling. `oauth: false`
prevents OpenCode from starting its automatic OAuth flow for this API-key-authenticated server.

Create a key with `gnt keys create`, or use an existing key that you stored securely. `gnt keys
list` shows IDs and status only; it cannot recover the secret. If the value is lost, create a new
key or run `gnt keys rotate <id>`. Make the key available to the process that starts OpenCode:

```bash
export GNT_MCP_KEY="gnt_live_..."
opencode
```

PowerShell:

```powershell
$env:GNT_MCP_KEY = "gnt_live_..."
opencode
```

Command Prompt (`cmd.exe`):

```bat
set "GNT_MCP_KEY=gnt_live_..."
opencode
```

OpenCode expands `{env:GNT_MCP_KEY}` while loading the configuration. Restart OpenCode after
changing the environment or configuration. Do not replace the environment reference with the real
key in a project config, and do not commit or paste the key into logs, issues, or support output.

## Load the action policy

OpenCode can load reusable instruction files through the top-level `instructions` array, as
described in its [rules documentation](https://opencode.ai/docs/rules). Copy this integration's
policy file into the project where OpenCode will work:

```bash
mkdir -p /path/to/project/.opencode
cp integrations/opencode/TOOLS.md /path/to/project/.opencode/gnt-brain.md
```

Then add that file to the project's existing `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "instructions": [".opencode/gnt-brain.md"]
}
```

Merge this field with the MCP configuration above and preserve any existing instruction paths.
As an alternative, merge the contents of `TOOLS.md` into the project's root `AGENTS.md`; OpenCode
loads that file automatically. A project-local instruction is easier to review and keeps the
guardrail close to the tools it protects.

Neither an MCP connection nor an instruction file is an enforcement boundary. The client or
executor that performs a side effect must still reject the action unless it receives an `allowed`
verdict for the exact recipient, amount, target, and scope.

## Verify the connection

Restart OpenCode, then list the configured MCP servers:

```bash
opencode mcp list
```

Confirm that `gnt-brain` is connected. If it is not, run `opencode mcp debug gnt-brain`, check that
OpenCode inherited `GNT_MCP_KEY`, and confirm that the URL ends in `/mcp/`. Do not include the
Authorization header in a bug report.

Then run two behavior checks against non-production test rules:

1. Ask OpenCode to take an action covered by a blocking rule. It must call `check_action` and stop
   when the verdict is `blocked`.
2. Ask OpenCode to take an action with no approved rule. It must stop and ask a human for approval
   when the verdict is `needs_human`.

Do not connect these checks to a real payment, messaging, or deletion tool. A connected MCP status
proves that the tools are reachable. The two prompts check that the instruction layer uses the
tools, while executor-side gating remains the final control.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| OpenCode reports an authentication error | Confirm `GNT_MCP_KEY` is present in the environment inherited by OpenCode, then restart it. |
| The server appears but does not connect | Confirm the entry uses `type: "remote"`, `oauth: false`, and a URL ending in `/mcp/`. |
| `{env:GNT_MCP_KEY}` is sent literally | Confirm the value is in `headers`, the environment variable is set, and OpenCode is current. |
| The policy is ignored | Confirm `.opencode/gnt-brain.md` is listed in the project's `instructions` array, or merge it into `AGENTS.md`. |
| `check_action` returns `needs_human` | Stop and ask the human; do not retry with a softer description or route around the check. |

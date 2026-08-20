# Connecting Cline to gnt-brain

gnt-brain is gnt's rules-governance MCP server. Once Cline is connected, it can use
`check_action`, `search_rules`, `get_rule`, `list_skill_packs`, and `get_skill_pack`.
The MCP connection makes those tools available; copy [`TOOLS.md`](TOOLS.md) into the
project's Cline rules so the agent knows when to use them. For the shared endpoint and key
background, see gnt's [generic MCP client guide](../../apps/docs/pages/docs/mcp-clients.mdx).

## Add the remote MCP server

This configuration follows Cline's current [MCP documentation](https://docs.cline.bot/mcp/mcp-overview)
(checked 2026-08-19). Cline's VS Code extension can edit the configuration from the MCP Servers
panel, while the current Cline CLI stores it in `~/.cline/mcp.json` on macOS and Linux. In the
extension, open the MCP Servers icon, choose **Configure**, then **Configure MCP Servers**.

The issue may refer to the older `cline_mcp_settings.json` filename. If an older Cline build still
opens that file, use the file opened by its **Configure MCP Servers** button; the server entry
itself has the same shape.

Add this entry to the existing `mcpServers` object:

```json
{
  "mcpServers": {
    "gnt-brain": {
      "type": "streamableHttp",
      "url": "https://api.gntai.dev/mcp/",
      "headers": {
        "Authorization": "Bearer ${env:GNT_MCP_KEY}"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Keep the trailing slash in the URL. The deployed server redirects `/mcp` to `/mcp/`, so this
points Cline at the final MCP endpoint instead of relying on redirect handling.

`${env:GNT_MCP_KEY}` is expanded by Cline before it opens the connection. The syntax is handled
recursively by Cline's [environment expansion code][cline-env-expansion].
If you use the Cline CLI wizard and it writes a nested `transport` object, keep that structure and
put `type`, `url`, and `headers` inside `transport`; the same values apply.

Create a key with `gnt keys create`, or use an existing key that you stored securely. `gnt keys
list` shows IDs and status only; it cannot recover the secret. If the value is lost, create a new
key or run `gnt keys rotate <id>`. Make the key available to the process that starts Cline:

```bash
export GNT_MCP_KEY="gnt_live_..."
cline
```

PowerShell:

```powershell
$env:GNT_MCP_KEY = "gnt_live_..."
cline
```

Command Prompt (`cmd.exe`):

```bat
set "GNT_MCP_KEY=gnt_live_..."
cline
```

Restart Cline after changing the environment. Do not replace the environment reference with the
real key in `mcp.json`, and do not commit or paste the key into logs, issues, or support output.
Keep `autoApprove` empty until you have reviewed what each server tool does.

## Load the action policy

Cline automatically loads Markdown and text files from a project's `.clinerules/` directory.
See the [Cline rules documentation](https://docs.cline.bot/customization/cline-rules) for the
workspace and global rule locations. Copy this integration's policy file into the project where
Cline will work:

```bash
mkdir -p /path/to/project/.clinerules
cp integrations/cline/TOOLS.md /path/to/project/.clinerules/gnt-check-action.md
```

The same policy can be installed globally in Cline's rules directory, but a project rule is easier
to review and keeps the guardrail close to the code it protects. If the project already has a
`.clinerules/` directory, add the file without replacing the existing rules.

For an on-demand version, Cline also supports [Agent Skills](https://docs.cline.bot/customization/skills).
The packaged skill in `skill/gnt-check-action/` can be copied to the recommended `.cline/skills/`
directory (or the compatible `.clinerules/skills/` directory) in the project:

```bash
mkdir -p /path/to/project/.cline/skills
cp -R integrations/cline/skill/gnt-check-action /path/to/project/.cline/skills/gnt-check-action
```

The skill is useful context, but `TOOLS.md` is the better choice when the check must be present in
every Cline turn.

Neither an MCP connection nor an instruction file is an enforcement boundary. The client or
executor that performs a side effect must still reject the action unless it receives an `allowed`
verdict for the exact recipient, amount, target, and scope.

## Verify the connection

After editing the configuration, use the Cline CLI to inspect it:

```bash
cline config mcp --json
cline mcp
```

In the VS Code extension, open the MCP Servers panel and confirm that `gnt-brain` is active and
that its five tools are listed. If it does not connect, check that Cline inherited `GNT_MCP_KEY`,
that the URL still ends in `/mcp/`, and that the JSON is part of the existing `mcpServers` object.
Do not include the Authorization header in a bug report.

Then run two behavior checks against non-production test rules:

1. Ask Cline to take an action covered by a blocking rule. It must call `check_action` and stop
   when the verdict is `blocked`.
2. Ask Cline to take an action with no approved rule. It must stop and ask a human for approval
   when the verdict is `needs_human`.

Do not connect these checks to a real payment, messaging, or deletion tool. A green MCP status
proves that the tools are reachable. The two prompts check that the instruction layer uses the
tools, while executor-side gating remains the final control.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Cline reports an authentication error | Confirm `GNT_MCP_KEY` is present in the environment inherited by Cline, then restart Cline. |
| The server appears but has no tools | Confirm the entry uses `type: "streamableHttp"` and the URL includes the trailing slash. |
| `${env:GNT_MCP_KEY}` is shown literally | Cline was not started with that environment variable, or the value is in the wrong config field. |
| The policy is ignored | Confirm the file is under the workspace's `.clinerules/` directory and has a `.md` or `.txt` extension. |
| `check_action` returns `needs_human` | Stop and ask the human; do not retry with a softer description or route around the check. |

[cline-env-expansion]: https://github.com/cline/cline/blob/main/apps/vscode/src/utils/envExpansion.ts

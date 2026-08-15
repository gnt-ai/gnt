# Connecting Cursor to gnt-brain

gnt-brain is gnt's rules-governance MCP server. Once Cursor is connected, it can use
`check_action`, `search_rules`, `get_rule`, `list_skill_packs`, and `get_skill_pack`.
The MCP entry only makes the tools available. Install the skill in this directory too, so
Cursor knows when it must call `check_action` and how to handle each verdict.

## Add the MCP server

We verified this config shape on 2026-08-15 against Cursor's current
[MCP documentation](https://cursor.com/docs/mcp). Cursor reads project servers from
`.cursor/mcp.json` and global servers from `~/.cursor/mcp.json`. Remote servers use a `url`
plus optional `headers`, and header values support `${env:NAME}` interpolation.

Add this entry to the `mcpServers` object in the appropriate `mcp.json`:

```json
{
  "mcpServers": {
    "gnt-brain": {
      "url": "https://api.gntai.dev/mcp/",
      "headers": {
        "Authorization": "Bearer ${env:GNT_MCP_KEY}"
      }
    }
  }
}
```

Keep the trailing slash in the URL. The deployed server redirects `/mcp` to `/mcp/`, so this
points Cursor at the final endpoint instead of relying on redirect handling.

`gnt keys create` prints a new key once. Use that value, or a plaintext key you already stored
securely. `gnt keys list` shows IDs and status only; it cannot recover the secret. If the value is
lost, create a new key or run `gnt keys rotate <id>`. Make the key available to the process that
starts Cursor:

```bash
export GNT_MCP_KEY="gnt_live_..."
cursor .
```

PowerShell:

```powershell
$env:GNT_MCP_KEY = "gnt_live_..."
cursor .
```

Restart Cursor from that environment if it was already running. Do not replace the environment
reference with the real key in `mcp.json`, and do not commit or paste the key into logs.

## Install the action-check skill

We verified the skill layout on 2026-08-15 against Cursor's current
[Agent Skills documentation](https://cursor.com/docs/skills). Cursor discovers a folder
containing `SKILL.md` under `.cursor/skills/` or `.agents/skills/` for a project, and under
the matching directories in the user's home directory for global use.

From this integration directory, install the packaged skill for one project:

```bash
mkdir -p /path/to/project/.cursor/skills
cp -R skill/gnt-check-action /path/to/project/.cursor/skills/gnt-check-action
```

For every Cursor project, copy it to the global skills directory instead:

```bash
mkdir -p ~/.cursor/skills
cp -R skill/gnt-check-action ~/.cursor/skills/gnt-check-action
```

Cursor can select the skill when a request matches its description, or you can invoke
`/gnt-check-action` in Agent chat. [`TOOLS.md`](TOOLS.md) contains the same policy in plain
Markdown if you need to merge it into an existing `AGENTS.md` or an always-applied Cursor rule.

The skill is guidance, not an enforcement boundary. Any client that performs side effects must
still reject the action unless it receives an `allowed` verdict for the exact recipient, amount,
target, and scope.

## Verify the connection

The installed Cursor Agent CLI exposes read-only checks for configured MCP servers:

```bash
cursor-agent mcp list
cursor-agent mcp enable gnt-brain
cursor-agent mcp list-tools gnt-brain
```

A newly discovered server starts in `needs approval`. Review the URL and headers first, then
approve it in Cursor or with `cursor-agent mcp enable gnt-brain`. The final command should list
all five tools named above.

If `gnt-brain` does not become active, confirm that Cursor inherited `GNT_MCP_KEY`, inspect MCP
Logs in Cursor's Output panel, and check that the URL retains its trailing slash.

Then open Agent chat and run two behavior checks against non-production test rules:

1. Ask Cursor to take an action covered by a blocking rule. It must call `check_action` and stop
   when the verdict is `blocked`.
2. Ask it to take an action with no approved rule. It must stop and ask for human approval when
   the verdict is `needs_human`.

Do not connect these checks to a real payment, messaging, or deletion tool. A successful MCP
connection proves tool availability. The two prompts prove that the instruction layer uses the
tool, while executor-side gating remains the final control.

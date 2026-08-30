# Connecting Gemini CLI to gnt-brain

gnt-brain is gnt's rules-governance MCP server. Once Gemini CLI is connected, it can use
`check_action`, `search_rules`, `get_rule`, `list_skill_packs`, and `get_skill_pack`.
The MCP connection only makes those tools available. Import [`TOOLS.md`](TOOLS.md) into a
`GEMINI.md` context file as well so the agent checks rules before taking a side effectful action.
For the shared endpoint and key background, see gnt's
[generic MCP client guide](../../apps/docs/pages/docs/mcp-clients.mdx).

## Add the remote MCP server

Gemini CLI reads global settings from `~/.gemini/settings.json` and project settings from
`.gemini/settings.json`. The configuration below follows Gemini CLI's official
[MCP server documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)
and [settings reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)
(checked 2026-08-30).

Add `gnt-brain` to the existing top-level `mcpServers` object:

```json
{
  "mcpServers": {
    "gnt-brain": {
      "httpUrl": "https://api.gntai.dev/mcp/",
      "headers": {
        "Authorization": "Bearer ${GNT_MCP_KEY}"
      },
      "includeTools": [
        "check_action",
        "search_rules",
        "get_rule",
        "list_skill_packs",
        "get_skill_pack"
      ],
      "timeout": 30000,
      "trust": false
    }
  }
}
```

Keep the trailing slash in the MCP URL. `httpUrl` selects Streamable HTTP, while `includeTools`
limits discovery to gnt-brain's five documented tools. Keep `trust` set to `false`: connecting a
server must not silently bypass Gemini CLI's tool confirmation layer.

Gemini CLI expands environment references in string settings before connecting, including values
inside `headers`. Create a key with `gnt keys create`, or use an existing key from `gnt keys list`,
then expose it to the process that starts Gemini CLI:

```bash
export GNT_MCP_KEY="gnt_live_..."
gemini
```

PowerShell:

```powershell
$env:GNT_MCP_KEY = "gnt_live_..."
gemini
```

Command Prompt (`cmd.exe`):

```bat
set "GNT_MCP_KEY=gnt_live_..."
gemini
```

Do not replace the environment reference with the real key, and do not commit the key or paste it
into an issue, log, screenshot, or support message. If Gemini CLI resolves the reference to an
empty string, restart it from a shell that has `GNT_MCP_KEY` set.

## Load the action policy

Gemini CLI loads project instructions from `GEMINI.md`. Its official
[context-file documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md)
supports importing another Markdown file with `@file.md`. Add this line to the project's existing
`GEMINI.md`, using a path that is correct from that file:

```markdown
@path/to/integrations/gemini-cli/TOOLS.md
```

Alternatively, copy the contents of `TOOLS.md` into the project-level `GEMINI.md`. Use
`~/.gemini/GEMINI.md` only when the same gnt-brain policy and credentials apply to every project
you open with Gemini CLI.

After adding or changing the context file, start a new session or run:

```text
/memory refresh
/memory show
```

Confirm that the output shown by `/memory show` includes the `check_action` instructions.

## Verify the connection

Start Gemini CLI from the shell where `GNT_MCP_KEY` is set. Then run:

```text
/mcp
/mcp desc
/mcp schema
```

The `gnt-brain` server should be connected and list exactly the five configured tools. If you
change `settings.json` while the session is open, run `/mcp reload` before checking again.

Run two behavior checks against non-production test rules:

1. Ask Gemini CLI to take an action covered by a blocking rule. It must call `check_action` and
   stop when the verdict is `blocked`.
2. Ask it to take an action with no approved rule. It must stop and ask a human when the verdict
   is `needs_human`.

Do not connect these checks to a real payment, messaging, or deletion tool. A connected MCP status
only proves that the tools are reachable. The prompts verify that the instruction layer calls the
tool, while executor-side gating remains the final enforcement boundary.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `gnt-brain` is missing from `/mcp` | Confirm the entry is inside the existing top-level `mcpServers` object, then run `/mcp reload`. |
| The server reports an authentication error | Confirm Gemini CLI inherited `GNT_MCP_KEY` and the URL ends in `/mcp/`; never paste the header value into a bug report. |
| The server connects but tools are missing | Run `/mcp schema` and confirm `includeTools` contains all five documented tool names. |
| The policy is absent from `/memory show` | Fix the `@` import path in `GEMINI.md`, then run `/memory refresh`. |
| `check_action` returns `needs_human` | Stop and ask the human; do not retry with a softer description or route around the check. |

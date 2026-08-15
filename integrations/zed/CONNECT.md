# Connecting Zed to gnt-brain

gnt-brain is gnt's rules-governance MCP server. Once Zed is connected, its Agent can use
`check_action`, `search_rules`, `get_rule`, `list_skill_packs`, and `get_skill_pack`.
The connection makes those tools available, but it does not force the Agent to use them. Install
the skill in this directory too, or merge `TOOLS.md` into the project's instructions.

## Add the remote MCP server

We verified this config shape on 2026-08-15 against Zed's current
[MCP documentation](https://zed.dev/docs/ai/mcp) and the settings schema in
[`settings_content`](https://github.com/zed-industries/zed/blob/main/crates/settings_content/src/project.rs).
Zed stores custom MCP servers under `context_servers`; a remote server accepts `url`, `headers`,
`enabled`, and an optional timeout.

Open Zed's Command Palette, run `zed: open settings file`, and add this entry to the existing
top-level settings object:

```json
{
  "context_servers": {
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
points Zed at the final endpoint.

`gnt keys create` prints a new key once. Use that value, or a plaintext key you already stored
securely. `gnt keys list` shows IDs and status only; it cannot recover the secret. If the value is
lost, create a new key or run `gnt keys rotate <id>`. Replace only the placeholder inside your
user settings file.

Zed 1.15 does not interpolate environment variables in remote MCP headers. Its HTTP settings
schema treats each header value as a literal string and passes that map to the transport. This
means the native token setup stores the key in Zed's local settings file. Do not put this entry
in a project's `.zed/settings.json`, commit it, paste it into logs, or share the file. If local
plaintext token storage is outside your security policy, do not use this native setup until
gnt-brain supports Zed's MCP OAuth flow or Zed adds secure header interpolation.

## Install the action-check skill

We verified the package layout on 2026-08-15 against Zed's current
[Agent Skills documentation](https://zed.dev/docs/ai/skills). Zed loads global skills from
`~/.agents/skills/` and project skills from `<worktree>/.agents/skills/`. Project skills load
only after the worktree is trusted.

From this integration directory, install the packaged skill for one project:

```bash
mkdir -p /path/to/project/.agents/skills
cp -R skill/gnt-check-action /path/to/project/.agents/skills/gnt-check-action
```

For every Zed project, copy it to the global skills directory instead:

```bash
mkdir -p ~/.agents/skills
cp -R skill/gnt-check-action ~/.agents/skills/gnt-check-action
```

Zed can select the skill when a request matches its description. You can also invoke it with
`/gnt-check-action` or an `@` mention in the Agent Panel. [`TOOLS.md`](TOOLS.md) contains the
same policy in plain Markdown. Merge it into the project's root `AGENTS.md` when the instruction
must be present in every Agent chat. Preserve any instructions already in that file.

The skill and instruction file are guidance, not an enforcement boundary. Any client that
performs side effects must reject the action unless it receives an `allowed` verdict for the
exact recipient, amount, target, and scope.

## Prompt snippet

If you do not install the packaged skill, add this snippet to the project's root `AGENTS.md` or
paste it into the Agent Panel before asking Zed to act:

```text
Before sending a message, moving money, deleting data, or taking another action that is hard to
undo, call gnt-brain's check_action tool with the exact action. Proceed only when the verdict is
allowed for the same recipient, amount, target, and scope. Stop on blocked. Stop and ask a human
on needs_human. A missing, failed, expired, or unclear verdict is not permission to continue.
```

This prompt tells the Agent when to call the tool. The system that performs the side effect must
still enforce the returned verdict.

## Verify the connection

Open Settings, select AI, then MCP Servers. The indicator next to `gnt-brain` should be green and
its tooltip should say `Server is active`. If it is not active, check the URL, the Authorization
header, and the MCP server status shown by Zed. Do not copy the header value into a bug report.

Then run two behavior checks in the Agent Panel against non-production test rules:

1. Ask Zed to take an action covered by a blocking rule. It must call `check_action` and stop
   when the verdict is `blocked`.
2. Ask it to take an action with no approved rule. It must stop and ask for human approval when
   the verdict is `needs_human`.

Do not connect these checks to a real payment, messaging, or deletion tool. A green server
indicator proves the MCP connection. The prompts prove that the instruction layer uses the tool,
while executor-side gating remains the final control.

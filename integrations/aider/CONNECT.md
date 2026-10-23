# Connecting Aider to gnt-brain

gnt-brain is gnt's rules-governance MCP server. Once an agent is connected, it can use `check_action`, `search_rules`, `get_rule`, `list_skill_packs`, and `get_skill_pack` to check a planned action against your org's rules before taking it, and to look rules and skill packs up while it works.

Aider cannot use those tools yet: as of v0.86.1 (the latest release), Aider has no MCP client support, so there is no Aider setting that attaches the gnt-brain endpoint the way the other integrations in this directory do. This was checked on 2026-10-23 against Aider's options reference and release history — no MCP option exists. This guide documents the route that works today instead: load [`TOOLS.md`](TOOLS.md) into every session as a read-only conventions file, so the model works with the check-before-acting policy and the tool contracts in context. When Aider ships MCP client support, this page should be replaced with the native configuration the other integrations use — the remote endpoint `https://api.gntai.dev/mcp/` with a Bearer MCP key from `gnt keys create`.

## Load the tool contracts

Copy this directory's `TOOLS.md` into the root of the repo you use with Aider, then tell Aider to load it read-only on every run. In `.aider.conf.yml` in the repo root:

```yaml
read:
  - TOOLS.md
```

Or per session:

```bash
aider --read TOOLS.md
```

A file loaded this way is in the chat context from the first message, and Aider never edits it. No MCP key is needed for this route — nothing connects to the endpoint. MCP keys matter only for the MCP-capable clients.

## What this does not give you

There are no live tool calls. Aider cannot ask gnt-brain to evaluate an action, search your org's rules, or fetch a skill pack mid-task, so nothing is enforced at action time the way it is with an MCP-connected agent (Goose, Zed, and the others in this directory). What you get is the policy in context: the model knows it is expected to check before acting, what the verdicts mean, and when to stop for a human. `TOOLS.md`'s own fallback applies throughout — since `check_action` is always unavailable from Aider, an action that would need a check is escalated to you as `needs_human`. Treat this as standing instructions the model follows, not as a check that runs.

## Run gnt CLI commands with /run

Aider runs shell commands from the chat with `/run`, and the output lands in the conversation. The gnt CLI command that fits an Aider session is the local one — validating rule files you are editing, before they go up in a PR:

```text
/run gnt rules lint
```

`gnt rules lint` checks rule frontmatter shape locally (default path `./.rules`). It is a convenience for working on rule files, not a substitute for `check_action`, which only the MCP server exposes.

## Verify the setup

1. Start Aider from the repo root, so it picks up `.aider.conf.yml`. `TOOLS.md` should be listed with the read-only files in the chat. If it is not, the `read:` entry is not being picked up — check the file name and that you launched from the repo root.
2. Ask: "What are you supposed to do before a side-effectful action in this repo?" The answer should track `TOOLS.md`: check the action against the org's rules first, treat a block as a stop, and escalate to a human when a check would need one — and it should be clear that Aider cannot place that call itself today.

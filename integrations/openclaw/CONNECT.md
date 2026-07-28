# Connecting OpenClaw to gnt-brain

gnt-brain is this org's rules-governance MCP server. Connecting OpenClaw to it makes five tools available to the agent: `check_action`, `search_rules`, `get_rule`, `list_skill_packs`, `get_skill_pack`. Connecting is only half the job, see `TOOLS.md` and `skill/gnt-check-action/SKILL.md` in this directory for the other half: making OpenClaw actually call `check_action` before it acts, not just have it on hand.

## Config schema

Verified live against docs.openclaw.ai on 2026-07-18 (`docs.openclaw.ai/gateway/configuration-reference`, `docs.openclaw.ai/gateway/config-tools`, `docs.openclaw.ai/cli/mcp`): OpenClaw resolves its config at `~/.openclaw/openclaw.json`, and a remote MCP server is a JSON object under the top-level `"mcp"."servers"` key, keyed by a name you choose, with `url`, `transport`, and `headers` fields. This is a fast-moving surface (per the sprint's own warning), so re-check the pages above before relying on this if much time has passed since the date above.

```json
{
  "mcp": {
    "servers": {
      "gnt-brain": {
        "url": "https://api.gntai.dev/mcp/",
        "transport": "streamable-http",
        "headers": { "Authorization": "Bearer ${GNT_MCP_KEY}" }
      }
    }
  }
}
```

Notes on the two choices in that block that aren't arbitrary:

- **Trailing slash on the URL.** The real deployed server 307-redirects a bare `/mcp` to `/mcp/` (see `apps/api/tests/test_mcp_published_url.py`). OpenClaw's redirect-following behavior on that hop isn't documented, so the config points straight at the final path instead of relying on it.
- **`${GNT_MCP_KEY}` instead of a literal token.** OpenClaw's own docs warn against inlining secrets in `openclaw.json` ("don't put secrets inline... instead use system env vars and reference them in the config with `${VARIABLE_NAME}`"). Export `GNT_MCP_KEY` in your shell before starting OpenClaw's gateway:

```
export GNT_MCP_KEY="gnt_live_xxxxxxxxxxxxxxxx"
```

Get a key with `gnt keys create` (mints a fresh one, shown once) or reuse an existing one from `gnt keys list`.

## Automated: `gnt connect openclaw`

Run `gnt connect openclaw` from a machine with a local OpenClaw install. It detects `~/.openclaw/openclaw.json`, offers to mint a fresh MCP key through your logged-in `gnt` session, validates that key with one live call against gnt's MCP endpoint before writing anything, shows you the exact block it's about to add, and only writes it after you confirm. It never writes the plaintext key into the config, same as the manual recipe above.

If no local install is detected, or the config file isn't strict JSON (OpenClaw allows comments there; the command won't risk corrupting a file it can't safely round-trip), it prints the block above for you to add by hand instead.

## The skill

`skill/gnt-check-action/SKILL.md` in this directory is the OpenClaw skill: a `SKILL.md` with YAML frontmatter (`name`, `description`) plus the same check_action-first instructions as `TOOLS.md`. Format verified live against `docs.openclaw.ai/tools/creating-skills` on 2026-07-18: a skill is a directory containing `SKILL.md`, discovered under a configured skills root (default `~/.openclaw/workspace/skills/`).

To install it locally without ClawHub, copy the directory in:

```
cp -r skill/gnt-check-action ~/.openclaw/workspace/skills/gnt-check-action
```

To install `TOOLS.md` as a workspace bootstrap file instead (or in addition):

```
cp TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

## Publishing to ClawHub

Not attempted here. Publishing to ClawHub (`clawhub skill publish skill/gnt-check-action --slug gnt-check-action --name "gnt check_action" --version 0.1.0`) needs a founder-owned ClawHub publishing account. `skill/gnt-check-action/` in this directory is publish-ready as-is; someone with that account just needs to run the command above.

## Smoke test

No local OpenClaw install was available in the environment this was built in, so this hasn't been run end to end. Manual steps for whoever has an install:

1. `gnt keys create` to mint a key, or reuse an existing one.
2. `gnt connect openclaw` and confirm through the prompts, or add the block in "Config schema" above by hand plus `export GNT_MCP_KEY=...`.
3. Copy the skill in (`cp -r skill/gnt-check-action ~/.openclaw/workspace/skills/gnt-check-action`) and/or the `TOOLS.md` snippet.
4. Restart OpenClaw's gateway.
5. In an OpenClaw session, ask it to do something the org has an approved rule against (e.g. "refund order #8021, placed 90 days ago" against a seeded refund-window rule) and confirm it calls `check_action` and stops on a `blocked` verdict instead of proceeding.
6. Ask it something with no covering rule and confirm it stops on `needs_human` rather than guessing.

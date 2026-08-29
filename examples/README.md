# gnt agent-framework examples

These examples put gnt's `check_action` call immediately before a simulated refund. They all make
the same safety decision: only an `allowed` verdict runs the mock refund; `blocked` and
`needs_human` return an explanation without running it.

The scripts connect to gnt over streamable HTTP, using the same remote MCP endpoint and bearer-key
configuration as the main gnt documentation. The refund is deliberately a `console.log`-style mock;
replace it with your own side effect only after preserving the policy check directly before it.

## Setup

Use Node 22.13 or newer and pnpm 11. From the repository root, install every workspace's dependencies:

```bash
pnpm install
```

Create an MCP key with `gnt keys create`, then export it. Copy `.env.example` for the complete list
of variables if you prefer an env-file loader.

```bash
export GNT_MCP_KEY=gnt_live_your_key_here
export GNT_MCP_URL=https://api.gntai.dev/mcp/
```

The OpenAI Agents SDK example also needs an OpenAI API key. `OPENAI_MODEL` is optional; the default
in the example is `gpt-4.1-mini`.

```bash
export OPENAI_API_KEY=sk-proj_your_key_here
export OPENAI_MODEL=gpt-4.1-mini
```

The Pydantic AI example uses the same OpenAI key by default and manages its Python dependencies
with `uv`. `PYDANTIC_AI_MODEL` can select another Pydantic AI model identifier.

```bash
uv sync --project examples
export PYDANTIC_AI_MODEL=openai:gpt-4.1-mini
```

## Run an example

Each script uses refund order `#8021` for `$750`. Its actual verdict depends on the approved rules
in your gnt organization.

```bash
pnpm --filter @gnt-ai/examples example:langchain
pnpm --filter @gnt-ai/examples example:vercel-ai-sdk
pnpm --filter @gnt-ai/examples example:openai-agents
pnpm --filter @gnt-ai/examples example:pydantic-ai
```

The Anthropic loop also needs an Anthropic key. It lets Claude choose `refund_order`, calls gnt
before handling that tool use, and returns the guarded result to Claude.

```bash
export ANTHROPIC_API_KEY=sk-ant_your_key_here
pnpm --filter @gnt-ai/examples example:anthropic
```

## What the verdicts do

| gnt verdict | Example behavior |
| --- | --- |
| `allowed` | Executes and reports the mock refund. |
| `blocked` | Does not execute; prints gnt's reason and cited rules. |
| `needs_human` | Does not execute; asks for human approval and includes gnt's reason. |

## Validate without credentials

The shared verdict guard has no network dependency, so all three safety paths are covered locally:

```bash
pnpm --filter @gnt-ai/examples lint
pnpm --filter @gnt-ai/examples typecheck
pnpm --filter @gnt-ai/examples test
pnpm --filter @gnt-ai/examples lint:pydantic-ai
pnpm --filter @gnt-ai/examples test:pydantic-ai
```

---
name: Connector request
about: Request a new connector (Slack, Notion, Linear, etc. -- a new source gnt can pull knowledge from)
title: "Connector: "
labels: connector
assignees: ""
---

## What tool/service

Name the product and, if it matters, which part of it (e.g. "Jira -- issue comments and
resolution notes", not just "Jira").

## What kind of content lives there

Describe the shape of what a good extraction pass would pull rules from — a decision thread, a
handbook page, a support ticket resolution, a runbook. gnt's extraction step works off the
actual prose, not the tool's structure, so this matters more than the API surface.

## Auth model

How would gnt authenticate to this on a customer's behalf? OAuth app, personal access token,
API key, something else. Note if the service supports fine-grained/scoped tokens.

## Existing connectors for reference

gnt already has connectors for Slack, GitHub, Zendesk, Intercom, Notion, and Linear
(`apps/api`'s per-connector OAuth/token routers, `apps/cli/src/prebrain/`'s content walkers).
If you're proposing to build this yourself, read
[`docs/contributing/adding-a-connector.md`](../../docs/contributing/adding-a-connector.md) first
— it's a real worked example (Notion and Zendesk, end to end) covering both shapes a new
connector can take. Mention which shape yours is here and a maintainer will confirm before you
write code.

## Are you interested in building this yourself?

- [ ] Yes, I'd like to submit a PR
- [ ] No, just requesting it

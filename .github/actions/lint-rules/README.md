# gnt rules lint (composite action)

Runs `gnt rules lint` against a `rules/` directory in CI — the same frontmatter
check `apps/api`'s `CreateRuleRequest` and `apps/store`'s `RuleStatus` enforce
server-side, after a PR round-trip, just earlier: on the PR itself, before a
maintainer opens it.

## Usage

```yaml
name: Lint rules
on: pull_request

jobs:
  lint-rules:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: gnt-ai/gnt/.github/actions/lint-rules@main
```

Uses `npx` under the hood, so nothing needs to be installed ahead of time beyond
Node itself (already present on GitHub-hosted runners).

## Inputs

| Name      | Default  | Description                                                    |
| --------- | -------- | ---------------------------------------------------------------|
| `path`    | `rules`  | Directory (or single rule file) to lint                        |
| `version` | `latest` | `@gnt-ai/cli` npm version specifier to run, e.g. `0.6.1`        |

```yaml
      - uses: gnt-ai/gnt/.github/actions/lint-rules@main
        with:
          path: rules/finance
          version: 0.6.1
```

Pin `version` (and the action ref itself, e.g. `@v1.0.2` instead of `@main`) if
you want a rules repo's CI to stay put across releases here rather than
picking up `gnt rules lint` changes automatically.

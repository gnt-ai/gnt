## What & why



## Test plan



## Before you open this

Reviewers here hold PRs to the same bar the maintainers hold their own changes to. Check these
before requesting review, not after:

- [ ] Commits are signed off (`git commit -s`) — see `CONTRIBUTING.md`'s DCO section.
- [ ] Functionally correct: you ran this, not just read it. If it touches `apps/api` or
      `apps/store`, you ran the relevant test suite locally.
- [ ] No dead code — no unused imports/variables, no commented-out blocks, no debug logging left
      behind.
- [ ] Non-trivial logic (a new branch, a parser, anything security- or money-adjacent) has a
      test. A one-line change doesn't need one; a new code path does.
- [ ] If this touches anything multi-tenant (rules, connectors, MCP keys, billing), it respects
      org/tenant isolation — no query or check that could leak one org's data to another.
- [ ] Matches this repo's existing patterns rather than introducing a new one for the same
      problem — see `CONTRIBUTING.md`'s code conventions.
- [ ] If this touches `apps/cli/src/prebrain/extraction/`, the PR description includes the
      recall/precision numbers from `bun run eval:extraction -- --mode cloud`.



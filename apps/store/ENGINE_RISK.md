# Third-party knowledge-store dependency — removed

`apps/store` used to import a private, third-party knowledge-store package
as raw, uncompiled `.ts` source (pinned to a commit hash) to back its
`GntStore` seam. That dependency was fully removed in favor of this
package's own native schema/CRUD/hybrid-search/git-sync implementation
(`src/native/`) once the replacement was built and proven against the
production retrieval eval — see `CUTOVER.md`.

Nothing in this tree imports it anymore. The design/containment history
(what it backed, what a replacement had to reproduce, the pin/patch
mechanics) lived here while the dependency was still live; it has no
public audience now that the dependency doesn't exist.

// The common source-document body shape every MCP-in adapter so far
// builds: a title heading, the item's own prose, and an optional comment
// thread under its own heading. Factored here so a new adapter gets the
// exact same assembly (and the same chunk output) as Notion and monday
// without re-deriving the join, and so the one place that decides how a
// document reads is shared rather than copied.
//
// `body` and `comments` are passed already prepared (trimmed as the
// adapter sees fit); this only joins them. An empty section is dropped, so
// an item with no comments has no dangling "## Comments" heading. The
// framework separately drops a document whose whole body is blank.
export function buildProseDocument(title: string, body: string, comments: string): string {
  return [`# ${title}`, body, comments ? `## Comments\n\n${comments}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

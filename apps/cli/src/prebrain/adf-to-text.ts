// Atlassian Document Format (ADF) to plain text, for mcp-jira.ts.
//
// Jira issue descriptions and comment bodies come back either as a plain
// string (markdown, when the adapter asks for responseContentFormat:
// "markdown") or as ADF -- a structured JSON node tree -- when a server
// doesn't honor that request. buildProseDocument/chunkText expect a plain
// string; handing them a raw ADF object would chunk on JSON punctuation
// instead of on the document's actual paragraph/heading structure and would
// leave every mention/media node's raw attrs (a mentioned user's Atlassian
// account id, a media file id) sitting in what's supposed to be prose-only
// content. This is the defensive fallback: walk the node tree and rebuild
// a plain-text-ish rendering (markdown-flavored, since chunkText already
// treats a markdown heading as a hard chunk boundary and this codebase's
// other adapters lean on that), keeping visible text and dropping every
// non-text attribute.
//
// Only a node's declared `content`/`text`/`marks`/`attrs` are ever read --
// see mcp-jira.ts's own doc comment for why those specific keys are what
// the framework's field-stripping allows through for this tool's response
// in the first place.

interface AdfNode {
  type?: unknown;
  content?: unknown;
  text?: unknown;
  marks?: unknown;
  attrs?: unknown;
}

function asNode(value: unknown): AdfNode | null {
  return value && typeof value === "object" ? (value as AdfNode) : null;
}

function asNodeList(value: unknown): AdfNode[] {
  if (!Array.isArray(value)) return [];
  return value.map(asNode).filter((n): n is AdfNode => n !== null);
}

function asAttrs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

// Joins rendered block-level children with a blank line, dropping any
// child that rendered to nothing (an empty paragraph, a dropped media
// node) rather than leaving a dangling blank line in its place.
function renderBlocks(nodes: AdfNode[]): string {
  return nodes
    .map(renderNode)
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

// Inline children (the contents of a paragraph/heading) join directly --
// spacing between words lives in the text nodes themselves, not between
// siblings.
function renderInline(nodes: AdfNode[]): string {
  return nodes.map(renderNode).join("");
}

// A mark wraps rendered text with formatting -- only `link` and `code` add
// anything a plain-text reader would want kept; the rest (strong, em,
// strike, underline, textColor, subsup) are visual-only and dropped, same
// "prose over formatting" bias every other adapter's parse function
// already applies to the fields it keeps.
function applyMarks(text: string, marksValue: unknown): string {
  if (!text) return text;
  const marks = asNodeList(marksValue);
  let result = text;
  for (const mark of marks) {
    if (mark.type === "link") {
      const href = asAttrs(mark.attrs).href;
      if (typeof href === "string" && href) result = `[${result}](${href})`;
    }
    if (mark.type === "code") result = `\`${result}\``;
  }
  return result;
}

function renderNode(node: AdfNode): string {
  const type = typeof node.type === "string" ? node.type : "";
  const children = asNodeList(node.content);

  switch (type) {
    case "doc":
      return renderBlocks(children);
    case "paragraph":
      return renderInline(children);
    case "heading": {
      const level = asAttrs(node.attrs).level;
      const depth = typeof level === "number" && level >= 1 && level <= 6 ? level : 1;
      const text = renderInline(children);
      return text ? `${"#".repeat(depth)} ${text}` : "";
    }
    case "blockquote": {
      const body = renderBlocks(children);
      return body
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    }
    case "codeBlock": {
      const code = children.map((child) => (typeof child.text === "string" ? child.text : "")).join("");
      return code ? `\`\`\`\n${code}\n\`\`\`` : "";
    }
    case "bulletList":
      return children.map((item) => `- ${renderNode(item)}`).join("\n");
    case "orderedList":
      return children.map((item, index) => `${index + 1}. ${renderNode(item)}`).join("\n");
    case "listItem":
      return renderBlocks(children);
    case "panel":
    case "expand":
    case "tableCell":
    case "tableHeader":
      return renderBlocks(children);
    case "table":
      return children.map(renderNode).join("\n");
    case "tableRow":
      return children.map(renderNode).join(" | ");
    case "rule":
      return "---";
    case "hardBreak":
      return "\n";
    case "text":
      return applyMarks(typeof node.text === "string" ? node.text : "", node.marks);
    case "mention": {
      // The display name a mention carries is prose (the same way an
      // @-mention typed inline in any other adapter's comment text would
      // be); the account id under the same attrs is not -- it identifies a
      // specific person to Atlassian's own systems and has no reason to
      // reach a rule body. Only attrs.text is ever read; attrs.id never is.
      const label = asAttrs(node.attrs).text;
      const name = typeof label === "string" && label ? label.replace(/^@/, "") : "someone";
      return `@${name}`;
    }
    case "emoji": {
      const shortName = asAttrs(node.attrs).shortName;
      return typeof shortName === "string" ? shortName : "";
    }
    // Media carries no text of its own -- the file id, collection, and
    // dimensions under its attrs are dropped by returning nothing rather
    // than by selectively filtering them, since none of it is prose.
    case "media":
    case "mediaSingle":
    case "mediaGroup":
    case "mediaInline":
      return "";
    default:
      // An ADF node type this converter doesn't know yet: still walk its
      // children for stray text rather than dropping the whole node, same
      // "don't fail the run over a shape surprise" bias mcp-linear.ts's own
      // parse functions apply -- an unrecognized node's own attrs are never
      // read either way, so nothing beyond visible text can leak through
      // this branch.
      return children.length > 0 ? renderBlocks(children) : "";
  }
}

// Converts an ADF document (or any ADF node) to a plain-text-ish rendering.
// A plain string input is returned trimmed, unchanged -- the common case
// once responseContentFormat: "markdown" is honored, handled here too so
// callers can pass either shape through one function without checking
// first. Anything else (null, a non-object) renders to "".
export function adfToPlainText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const node = asNode(value);
  if (!node) return "";
  return renderNode(node).trim();
}

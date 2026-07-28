// The adapter contract for an MCP-in connector (connector sprint T1).
//
// gnt's MCP-in connectors all do the same job: connect OUT, as a client,
// to a customer's own vendor MCP server (Notion, monday.com, and the nine
// more coming after this task), read prose from it, and hand it to the
// prebrain pipeline as PrebrainChunks. Before this framework existed, each
// walker hand-rolled the connection, the read-only allowlist, the
// field-by-field filtering, and the chunking. This file is the one
// contract they all implement instead, so a new connector is a single
// adapter object plus fixtures, and the guarantees below are enforced by
// the framework runner (walker.ts), not by each adapter remembering to.
//
// What the framework enforces for every adapter, structurally:
//   - Read-only allowlist: an adapter can only call the tools it declares
//     in `reads`. Anything else is refused before it reaches the server.
//   - Prose only: for a structured read, the framework strips every field
//     the adapter did not declare before the adapter ever sees the
//     response, so an undeclared record field (an email, a phone number)
//     is unreachable, not just unread. See fields.ts.
//   - Uniform provenance and chunking: adapters emit whole source
//     documents; the framework chunks them with the adapter's chosen
//     chunker and tags each chunk with the adapter's walker id, so every
//     chunk carries the same PrebrainChunk shape the rest of prebrain
//     (privacy gate, extraction, batched PRs) already depends on.
import type { StdioMcpServerSpec } from "../mcp-connector.js";
import type { TextChunk } from "../chunk.js";
import type { PrebrainChunk, PrebrainWalker } from "../types.js";

// Which chunker turns a source document's body into line-spanned chunks.
// The shared chunkText (chunk.ts) fits this exactly; a connector that
// wants a format-specific splitter (a transcript chunker, a mail chunker)
// declares it here instead, and the framework uses it with no other
// change. The signature is intentionally the one chunkText already has.
export type Chunker = (content: string) => TextChunk[];

// One tool an adapter is allowed to read, plus how the framework should
// treat its response. This IS the allowlist (the framework builds the set
// of callable tool names from the adapter's declared reads) AND the
// prose-only field declaration, in one place.
//
//   - "prose": the tool returns a text document (a page's markdown, a
//     transcript). The framework returns that text as-is; there are no
//     record fields to strip. Declare a tool prose only when its whole
//     response is the content you want.
//   - "structured": the tool returns records (search hits, comments,
//     board items). The framework parses the JSON and keeps ONLY the
//     `fields` named here, recursively, before the adapter sees it. A
//     field not listed here is stripped, so the adapter cannot read it
//     even by accident. `fields` is the exhaustive set of object keys the
//     adapter reads across the whole response tree, including container
//     keys it needs to descend through (e.g. "results", "items").
export type McpReadDeclaration =
  | { tool: string; kind: "prose" }
  | { tool: string; kind: "structured"; fields: readonly string[] };

// A source document an adapter produces: assembled prose plus the
// provenance path that follows it all the way to a rule's citation.
export interface McpSourceDocument {
  // The document's prose body, already assembled by the adapter (heading,
  // sections). The framework chunks this and nothing else. Use
  // buildProseDocument (document.ts) for the common title + body +
  // optional comments shape.
  body: string;
  // Provenance for every chunk of this document, carried on
  // PrebrainChunk.sourcePath. Use a vendor deep link where the vendor
  // supports one (a page URL), otherwise a stable id path that mirrors how
  // the vendor addresses the item (e.g. "boards/<id>/items/<id>"). A short
  // quoted excerpt is added later, downstream, from the chunk text itself
  // (extraction/index.ts), so an adapter never builds that here.
  sourcePath: string;
}

// What an adapter's walk is handed. The only way to touch the MCP server:
// the adapter never holds the raw client, so it cannot route around the
// allowlist or the field stripping.
export interface McpAdapterContext {
  // Call a tool declared `kind: "prose"` and get its text back. Refuses a
  // tool that is not on the allowlist, or one declared structured.
  readProse(tool: string, args?: Record<string, unknown>): Promise<string>;
  // Call a tool declared `kind: "structured"` and get back its parsed
  // response with every undeclared field already stripped. Refuses a tool
  // that is not on the allowlist, or one declared prose. Returns null if
  // the response was not JSON at all.
  readStructured(tool: string, args?: Record<string, unknown>): Promise<unknown>;
  // Hand the framework one finished source document. The framework chunks
  // it; an empty-bodied document is dropped, same as before.
  emitDocument(document: McpSourceDocument): void;
}

// A single MCP-in connector. `Params` is whatever per-run input this
// connector's walk needs beyond credentials (monday needs board ids;
// Notion needs nothing, so `void`). The public walker wrapper in the
// adapter file is what turns its own options into `Params`.
export interface McpInAdapter<Params = void> {
  // Stable id: the mcp-tokens.json key, the `gnt connect <id>` name, and
  // the health-line key. One string, used everywhere, so a typo is a
  // single wrong constant rather than a silent mismatch across files.
  id: string;
  // The PrebrainWalker tag stamped on every chunk this adapter emits. Must
  // be a member of the PrebrainWalker union (types.ts), so a new connector
  // extends that union in one place.
  walker: PrebrainWalker;
  // Human label for messages and the `gnt status` health line ("Notion",
  // "monday.com"). Never sent to any server.
  label: string;
  // The env var checked as a token fallback, after an explicit token and
  // before a stored one (e.g. "GNT_NOTION_MCP_TOKEN").
  tokenEnvVar: string;
  // Set only for a connector whose token can also be acquired through the
  // web dashboard's own OAuth flow (apps/api's GET /v1/<path>/token) --
  // e.g. "notion", "linear". Lets bootstrapDashboardToken (connect.ts)
  // fetch and locally cache an org's dashboard-connected credential the
  // first time this adapter's local token store comes up empty, so `gnt
  // prebrain --mcp-notion` works right after clicking "Connect" in the
  // dashboard with no separate CLI-side OAuth step. Omitted entirely for
  // every adapter with no server-side counterpart (most of them) -- those
  // never attempt this fetch at all.
  dashboardTokenPath?: string;
  // Built fresh so the specific Missing<Source>McpTokenError each adapter
  // exports (with its own "run `gnt connect ...`" message) is what a
  // caller catches, unchanged from before the framework.
  missingTokenError(): Error;
  // How to spawn the vendor's MCP server over stdio for a given token.
  // Only what this one child needs goes in `env` (never this CLI's own
  // environment) -- see connectStdioMcpServer's doc comment.
  server(token: string): StdioMcpServerSpec;
  // The exhaustive read-only tool allowlist and, for structured tools, the
  // exhaustive declared-field set. The framework derives both from here.
  reads: readonly McpReadDeclaration[];
  // Which chunker the framework runs this adapter's document bodies
  // through.
  chunker: Chunker;
  // One real read used to validate credentials in the connect flow before
  // anything is saved. Must name a declared tool.
  probe: { tool: string; args?: Record<string, unknown> };
  // The actual read walk. Uses only `ctx` to touch the server, and
  // `params` for per-run input. Throwing here is fine: the framework
  // always closes the connection, and prebrain's own collectChunks turns a
  // thrown walk into a skipped-and-reported source, never a crashed run.
  walk(ctx: McpAdapterContext, params: Params): Promise<void>;
}

// Collections of adapters (the registry, the status health list) don't
// care about any one adapter's Params, only its shared metadata. `never`
// erases the parameter so adapters with different Params types share one
// list type without `any`.
export type AnyMcpInAdapter = McpInAdapter<never>;

// The chunk shape the runner produces, re-exported for adapter files.
export type { PrebrainChunk };

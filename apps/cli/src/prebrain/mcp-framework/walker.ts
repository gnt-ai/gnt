// The framework runner: the one place that drives any MCP-in adapter
// through connect, allowlisted read, field stripping, chunking, and close.
// Every adapter's public walker wrapper delegates here, so all the
// framework guarantees (types.ts's header) live in this file, not in each
// adapter.
import { classifyDecisionProse } from "../chunk.js";
import {
  callReadOnlyTool,
  connectStdioMcpServer,
  McpConnectorError,
  tryParseJson,
} from "../mcp-connector.js";
import type { McpToolClient } from "../mcp-connector.js";
import { projectToDeclaredFields } from "./fields.js";
import type { AnyMcpInAdapter, McpAdapterContext, McpInAdapter, McpSourceDocument, PrebrainChunk } from "./types.js";

// The exhaustive set of tool names an adapter may call -- exactly its
// declared reads, nothing derived from what a live server advertises. This
// is what callReadOnlyTool checks against, so a tool an adapter never
// declared can't be called even if a future edit tried.
export function allowlistOf(adapter: AnyMcpInAdapter): ReadonlySet<string> {
  return new Set(adapter.reads.map((read) => read.tool));
}

function declarationFor(adapter: AnyMcpInAdapter, tool: string) {
  return adapter.reads.find((read) => read.tool === tool);
}

// Explicit token precedence, identical to what each adapter's
// resolve<Source>McpToken helper documented before the framework: an
// explicit token wins, then the adapter's env var, then a stored token.
// Missing from all three is the adapter's own typed error, so a caller
// still catches Missing<Source>McpTokenError.
export function resolveMcpToken<P>(
  adapter: McpInAdapter<P>,
  explicit: string | undefined,
  storedToken: string | undefined,
): string {
  const token = explicit ?? process.env[adapter.tokenEnvVar] ?? storedToken;
  if (!token) throw adapter.missingTokenError();
  return token;
}

export interface McpWalkOptions<P> {
  token?: string;
  storedToken?: string;
  // Injectable connection seam for tests -- production omits it and gets a
  // real stdio connection to the adapter's declared server. Same seam the
  // two original walkers exposed.
  connect?: (token: string) => Promise<McpToolClient>;
  // Per-run input this adapter's walk needs beyond credentials.
  params: P;
}

// Builds the sandboxed context an adapter's walk is given. The adapter
// never receives the raw client, so readProse/readStructured are the only
// ways to reach the server, and both enforce the allowlist; readStructured
// additionally strips undeclared fields.
function buildContext(
  adapter: AnyMcpInAdapter,
  client: McpToolClient,
  allowed: ReadonlySet<string>,
  documents: McpSourceDocument[],
): McpAdapterContext {
  return {
    async readProse(tool, args) {
      const declaration = declarationFor(adapter, tool);
      if (!declaration || declaration.kind !== "prose") {
        throw new McpConnectorError(`"${tool}" is not a declared prose read for ${adapter.label}.`);
      }
      return callReadOnlyTool(client, allowed, tool, args);
    },
    async readStructured(tool, args) {
      const declaration = declarationFor(adapter, tool);
      if (!declaration || declaration.kind !== "structured") {
        throw new McpConnectorError(`"${tool}" is not a declared structured read for ${adapter.label}.`);
      }
      const raw = await callReadOnlyTool(client, allowed, tool, args);
      return projectToDeclaredFields(tryParseJson(raw), new Set(declaration.fields));
    },
    emitDocument(document) {
      documents.push(document);
    },
  };
}

// Turns emitted documents into chunks: the adapter's chunker splits each
// body, and every chunk gets the adapter's walker tag and the document's
// sourcePath, matching the PrebrainChunk contract the rest of prebrain
// (gate, extraction, PR batching) already consumes. An empty-bodied
// document is dropped, same as the pre-framework walkers did.
function chunksFromDocuments(adapter: AnyMcpInAdapter, documents: McpSourceDocument[]): PrebrainChunk[] {
  const chunks: PrebrainChunk[] = [];
  for (const document of documents) {
    if (!document.body.trim()) continue;
    for (const chunk of adapter.chunker(document.body)) {
      chunks.push({
        text: chunk.text,
        sourcePath: document.sourcePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        walker: adapter.walker,
        looksLikeDecisionProse: classifyDecisionProse(chunk.text),
      });
    }
  }
  return chunks;
}

// Runs one adapter end to end. Resolves the token first (so a missing
// credential never opens a connection), connects, runs the adapter's walk
// against a sandboxed context, ALWAYS closes the connection, then chunks
// whatever the walk emitted. A walk that throws propagates after close --
// prebrain's collectChunks turns that into a skipped-and-reported source,
// never a crashed run.
export async function runMcpInWalk<P>(
  adapter: McpInAdapter<P>,
  options: McpWalkOptions<P>,
): Promise<PrebrainChunk[]> {
  const token = resolveMcpToken(adapter, options.token, options.storedToken);
  const connect = options.connect ?? ((t: string) => connectStdioMcpServer(adapter.server(t)));

  const client = await connect(token);
  const documents: McpSourceDocument[] = [];
  const context = buildContext(adapter, client, allowlistOf(adapter), documents);

  try {
    await adapter.walk(context, options.params);
  } finally {
    await client.close();
  }

  return chunksFromDocuments(adapter, documents);
}

// One real read against a live server, used by the connect flow to prove a
// pasted credential actually works before it's written to disk. Opens a
// connection, calls the adapter's declared probe tool through the same
// allowlist gate, and always closes. Throws (McpConnectorError or the
// transport's own error) if the read fails, so the connect flow can report
// it and save nothing.
export async function validateConnection<P>(
  adapter: McpInAdapter<P>,
  token: string,
  connect?: (token: string) => Promise<McpToolClient>,
): Promise<void> {
  const declaration = declarationFor(adapter, adapter.probe.tool);
  if (!declaration) {
    throw new McpConnectorError(`${adapter.label}'s probe tool "${adapter.probe.tool}" is not a declared read.`);
  }
  const open = connect ?? ((t: string) => connectStdioMcpServer(adapter.server(t)));
  const client = await open(token);
  try {
    await callReadOnlyTool(client, allowlistOf(adapter), adapter.probe.tool, adapter.probe.args);
  } finally {
    await client.close();
  }
}

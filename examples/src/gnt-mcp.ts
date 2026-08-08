import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_GNT_MCP_URL = "https://api.gntai.dev/mcp/";
const VERDICTS = new Set(["allowed", "blocked", "needs_human"]);

export type CheckActionVerdict = "allowed" | "blocked" | "needs_human";

export interface CheckActionResult {
  verdict: CheckActionVerdict;
  reason: string;
  cited_rules: Array<{ id: string; title: string }>;
  rules_retrieved: number;
}

export interface CheckActionInput {
  description: string;
  context?: string;
}

export interface GntMcpClient {
  checkAction(input: CheckActionInput): Promise<CheckActionResult>;
  close(): Promise<void>;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Copy .env.example and set a real value first.`);
  }
  return value;
}

function isCheckActionResult(value: unknown): value is CheckActionResult {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<CheckActionResult>;
  return (
    typeof candidate.verdict === "string" &&
    VERDICTS.has(candidate.verdict) &&
    typeof candidate.reason === "string" &&
    Array.isArray(candidate.cited_rules) &&
    typeof candidate.rules_retrieved === "number"
  );
}

function parseCheckActionResult(value: unknown): CheckActionResult {
  if (isCheckActionResult(value)) return value;
  throw new Error("gnt returned a check_action response with an unexpected shape.");
}

export async function connectGntMcp(): Promise<GntMcpClient> {
  const transport = new StreamableHTTPClientTransport(
    new URL(process.env.GNT_MCP_URL ?? DEFAULT_GNT_MCP_URL),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${requiredEnvironment("GNT_MCP_KEY")}` },
      },
    },
  );
  const client = new Client({ name: "gnt-check-action-examples", version: "0.1.0" });
  await client.connect(transport);

  return {
    async checkAction(input) {
      const response = await client.callTool({
        name: "check_action",
        arguments: input.context
          ? { description: input.description, context: input.context }
          : { description: input.description },
      });

      if (response.isError) {
        throw new Error(`gnt check_action failed: ${JSON.stringify(response.content)}`);
      }

      if (response.structuredContent) return parseCheckActionResult(response.structuredContent);

      const content = response.content;
      if (!Array.isArray(content)) {
        throw new Error("gnt check_action returned content in an unexpected format.");
      }

      const text = content.find(
        (item): item is { type: "text"; text: string } =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "text" &&
          "text" in item &&
          typeof item.text === "string",
      );
      if (!text) throw new Error("gnt check_action returned no text content.");
      return parseCheckActionResult(JSON.parse(text.text));
    },
    async close() {
      await client.close();
    },
  };
}

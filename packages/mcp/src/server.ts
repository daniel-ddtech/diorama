import { readFileSync } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler(args: Record<string, unknown>): Promise<unknown>;
}

export type ToolRegistry = Record<string, ToolDefinition>;

export interface CreateServerOptions {
  tools: ToolRegistry;
  input?: Readable;
  output?: Writable;
}

export interface McpServer {
  start(): Promise<void>;
}

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcError {
  code: number;
  message: string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version?: unknown };
const serverVersion = typeof packageJson.version === "string"
  ? packageJson.version
  : "0.0.0";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestId(value: Record<string, unknown>): JsonRpcId | undefined {
  if (!("id" in value)) return undefined;
  const id = value.id;
  return typeof id === "string" || typeof id === "number" || id === null
    ? id
    : undefined;
}

function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolError(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function toolResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  try {
    return {
      content: [{ type: "text", text: JSON.stringify(value ?? null) }],
    };
  } catch (error) {
    return toolError(error);
  }
}

async function handleRequest(
  raw: unknown,
  tools: ToolRegistry,
): Promise<JsonRpcResponse | undefined> {
  if (!isRecord(raw)) return errorResponse(null, -32600, "Invalid Request");
  const id = requestId(raw);
  if (raw.jsonrpc !== "2.0" || typeof raw.method !== "string") {
    return errorResponse(id ?? null, -32600, "Invalid Request");
  }

  const request = raw as unknown as JsonRpcRequest;
  if (request.method === "notifications/initialized") return undefined;

  let result: unknown;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "diorama", version: serverVersion },
      };
      break;

    case "tools/list":
      result = {
        tools: Object.values(tools).map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      };
      break;

    case "tools/call": {
      if (!isRecord(request.params) || typeof request.params.name !== "string") {
        if (id === undefined) return undefined;
        return errorResponse(id, -32602, "Invalid params");
      }
      const tool = tools[request.params.name];
      if (!tool) {
        result = toolError(new Error(`Unknown tool: ${request.params.name}`));
        break;
      }
      const args = request.params.arguments ?? {};
      if (!isRecord(args)) {
        if (id === undefined) return undefined;
        return errorResponse(id, -32602, "Invalid params");
      }
      try {
        result = toolResult(await tool.handler(args));
      } catch (error) {
        result = toolError(error);
      }
      break;
    }

    case "ping":
      result = {};
      break;

    default:
      if (id === undefined) return undefined;
      return errorResponse(id, -32601, "Method not found");
  }

  if (id === undefined) return undefined;
  return { jsonrpc: "2.0", id, result };
}

async function writeResponse(output: Writable, response: JsonRpcResponse): Promise<void> {
  if (output.write(`${JSON.stringify(response)}\n`)) return;
  await once(output, "drain");
}

export function createServer(options: CreateServerOptions): McpServer {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  let started = false;

  return {
    async start(): Promise<void> {
      if (started) throw new Error("MCP server has already been started");
      started = true;
      const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
      for await (const line of lines) {
        if (line.trim() === "") continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          await writeResponse(output, errorResponse(null, -32700, "Parse error"));
          continue;
        }
        const response = await handleRequest(raw, options.tools);
        if (response) await writeResponse(output, response);
      }
    },
  };
}

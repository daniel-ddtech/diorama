import { Duplex } from "node:stream";

import { describe, expect, it } from "vitest";

import { createServer, type ToolRegistry } from "../src/server.js";
import { createToolRegistry } from "../src/tools.js";

class MemoryDuplex extends Duplex {
  readonly output: Buffer[] = [];

  override _read(): void {}

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.output.push(Buffer.from(chunk));
    callback();
  }
}

async function exchange(
  tools: ToolRegistry,
  messages: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const transport = new MemoryDuplex();
  const running = createServer({ tools, input: transport, output: transport }).start();
  transport.push(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
  transport.push(null);
  await running;
  return Buffer.concat(transport.output)
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("MCP stdio server", () => {
  it("initializes, lists every tool schema, validates inline YAML, and rejects unknown methods", async () => {
    const tools = createToolRegistry();
    const responses = await exchange(tools, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "validate_sheet",
          arguments: {
            yaml: `
version: 1
title: Inline test
viewport: { width: 800, height: 600, scale: 1 }
extension: { path: ./extension }
steps:
  - { verb: goto, url: https://example.com }
`,
          },
        },
      },
      { jsonrpc: "2.0", id: 4, method: "not/a/method" },
    ]);

    expect(responses).toHaveLength(4);
    expect(responses[0]).toEqual(expect.objectContaining({
      id: 1,
      result: expect.objectContaining({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: expect.objectContaining({ name: "diorama" }),
      }),
    }));

    const listResult = responses[1]!.result as { tools: Array<Record<string, unknown>> };
    expect(listResult.tools.map((entry) => entry.name)).toEqual(Object.keys(tools));
    expect(listResult.tools.every((entry) => (
      typeof entry.description === "string"
      && typeof entry.inputSchema === "object"
    ))).toBe(true);

    const callResult = responses[2]!.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(JSON.parse(callResult.content[0]!.text)).toEqual({
      ok: true,
      title: "Inline test",
      stepCount: 1,
    });
    expect(responses[3]).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32601, message: "Method not found" },
    });
  });

  it("turns handler failures into tool errors", async () => {
    const responses = await exchange({
      explode: {
        name: "explode",
        description: "Throw an error.",
        inputSchema: { type: "object" },
        async handler() {
          throw new Error("boom");
        },
      },
    }, [{
      jsonrpc: "2.0",
      id: "failure",
      method: "tools/call",
      params: { name: "explode", arguments: {} },
    }]);

    const result = responses[0]!.result as {
      content: Array<{ text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: "boom" });
  });
});

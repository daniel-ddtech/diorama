import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createToolRegistry } from "../src/tools.js";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../engine/fixtures/test-extension",
);

function serveStage(): Promise<{ server: Server; url: string }> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html>
        <title>MCP stage</title>
        <button id="stage-button">Click me</button>
        <script>
          document.querySelector("#stage-button").addEventListener("click", (event) => {
            event.currentTarget.textContent = "Clicked";
          });
        </script>`);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({ server, url: `http://127.0.0.1:${port}/diorama-mcp-stage` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}

describe.skipIf(process.env.DIORAMA_IT !== "1")("MCP interactive session", () => {
  it("launches, opens the popup, interacts, captures both targets, and closes", async () => {
    const tools = createToolRegistry();
    const { server, url } = await serveStage();
    let sessionId: string | undefined;
    try {
      const launched = await tools.launch_session!.handler({
        extensionPath: fixtureDir,
        url,
        viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      }) as { sessionId: string; extensionId: string; stageTabId: number };
      sessionId = launched.sessionId;
      expect(launched.extensionId).toEqual(expect.any(String));
      expect(launched.stageTabId).toEqual(expect.any(Number));

      await expect(tools.open_popup!.handler({ sessionId })).resolves.toEqual({ ok: true });
      await expect(tools.click!.handler({
        sessionId,
        target: "page",
        selector: "#stage-button",
      })).resolves.toEqual({ ok: true });

      const page = await tools.screenshot!.handler({
        sessionId,
        target: "page",
      }) as { path: string; base64Length: number };
      const popup = await tools.screenshot!.handler({
        sessionId,
        target: "popup",
      }) as { path: string; base64Length: number };
      expect((await stat(page.path)).size).toBeGreaterThan(0);
      expect((await stat(popup.path)).size).toBeGreaterThan(0);
      expect(page.base64Length).toBeGreaterThan(0);
      expect(popup.base64Length).toBeGreaterThan(0);

      await expect(tools.close_session!.handler({ sessionId })).resolves.toEqual({ ok: true });
      sessionId = undefined;
    } finally {
      if (sessionId) {
        await tools.close_session!.handler({ sessionId });
      }
      await closeServer(server);
    }
  }, 120_000);
});

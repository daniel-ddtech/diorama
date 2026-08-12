import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Engine } from "../src/engine.js";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/test-extension",
);

// Extensions cannot inject into data: URLs, so the executeScript tabId probe
// needs a real http origin, serve the stage page locally.
function serveStage(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<title>stage</title><h1>stage</h1>");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/diorama-stage` });
    });
  });
}

describe.skipIf(process.env.DIORAMA_IT !== "1")("engine integration", () => {
  it("routes active-tab queries from an extension page to the stage", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "diorama-engine-it-"));
    const { server, url: stageUrl } = await serveStage();
    let engine: Engine | undefined;

    try {
      engine = await Engine.launch({
        userDataDir: profileDir,
        extensionDir: fixtureDir,
      });
      const { extensionId, swSession } = await engine.findExtension(/diorama fixture/i);
      const stage = await engine.createStage(stageUrl, {
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
      });
      await engine.cdp.waitForExpression(
        stage.session,
        "document.title === 'stage'",
        { label: "fixture stage loaded" },
      );
      const stageTabId = await engine.resolveStageTabId(swSession, "/diorama-stage");
      const popup = await engine.openExtensionPage(extensionId, "popup.html", {
        shimTabId: stageTabId,
        width: 400,
        height: 240,
        deviceScaleFactor: 1,
      });
      await engine.cdp.waitForExpression(
        popup.session,
        "document.querySelector('#active-tab')?.textContent !== 'loading'",
        { label: "fixture popup resolved active tab" },
      );
      const activeTabText = await engine.cdp.evaluate<string>(
        popup.session,
        "document.querySelector('#active-tab').textContent",
      );
      expect(activeTabText).toContain(String(stageTabId));

      const image = await engine.screenshot(popup.session, { format: "jpeg", quality: 80 });
      expect(Buffer.isBuffer(image)).toBe(true);
      expect([...image.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    } finally {
      if (engine) await engine.close();
      server.close();
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 60_000);
});

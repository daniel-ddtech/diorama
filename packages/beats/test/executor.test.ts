import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Engine } from "@diorama/engine";
import { describe, expect, it } from "vitest";

import { runBeats } from "../src/executor.js";
import { parseBeatSheet } from "../src/schema.js";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../engine/fixtures/test-extension",
);

function serveStage(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html>
        <title>beats stage</title>
        <button id="btn">Press me</button>
        <div id="counter">0</div>
        <input id="field">
        <script>
          document.querySelector("#btn").addEventListener("click", () => {
            const counter = document.querySelector("#counter");
            counter.textContent = String(Number(counter.textContent) + 1);
          });
        </script>`);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/diorama-beats-stage` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe.skipIf(process.env.DIORAMA_IT !== "1")("beats executor integration", () => {
  it("drives real input and opens a popup shimmed to the stage tab", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "diorama-beats-it-"));
    const { server, url: stageUrl } = await serveStage();
    let engine: Engine | undefined;

    try {
      engine = await Engine.launch({
        userDataDir: profileDir,
        extensionDir: fixtureDir,
      });
      const extension = await engine.findExtension(/diorama fixture/i);
      const sheet = parseBeatSheet(`
version: 1
title: executor integration
viewport: { width: 800, height: 600, scale: 1 }
extension:
  path: ${JSON.stringify(fixtureDir)}
  popup: { width: 400, height: 240 }
output: { holdTailMs: 0 }
steps:
  - { verb: goto, url: ${JSON.stringify(stageUrl)} }
  - { verb: wait, selector: "#btn" }
  - { verb: click, selector: "text=Press me" }
  - { verb: type, selector: "#field", text: "hi", perCharMs: 0 }
  - { verb: openPopup }
  - { verb: wait, target: popup, selector: "#active-tab" }
  - { verb: mark, name: done }
`);

      const result = await runBeats(engine, extension, sheet, {});
      const counter = await engine.cdp.evaluate<string>(
        result.stage.session,
        "document.querySelector('#counter').textContent",
      );
      const fieldValue = await engine.cdp.evaluate<string>(
        result.stage.session,
        "document.querySelector('#field').value",
      );
      expect(counter).toBe("1");
      expect(fieldValue).toBe("hi");

      expect(result.popup).toBeDefined();
      await engine.cdp.waitForExpression(
        result.popup!.session,
        "document.querySelector('#active-tab')?.textContent !== 'loading'",
        { label: "fixture popup resolved active tab" },
      );
      const stageTabId = await engine.resolveStageTabId(
        extension.swSession,
        new URL(stageUrl).pathname,
      );
      const activeTabText = await engine.cdp.evaluate<string>(
        result.popup!.session,
        "document.querySelector('#active-tab').textContent",
      );
      expect(activeTabText).toContain(String(stageTabId));

      for (let index = 1; index < result.events.length; index += 1) {
        expect(result.events[index]!.tStartMs)
          .toBeGreaterThanOrEqual(result.events[index - 1]!.tStartMs);
      }
      const clickEvent = result.events.find((event) => event.verb === "click");
      expect(clickEvent?.x).toEqual(expect.any(Number));
      expect(clickEvent?.y).toEqual(expect.any(Number));
      expect(result.events).toContainEqual(expect.objectContaining({
        verb: "mark",
        name: "done",
      }));
    } finally {
      if (engine) await engine.close();
      await closeServer(server);
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 60_000);
});

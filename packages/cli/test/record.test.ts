import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { recordCommand } from "../src/record.js";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../engine/fixtures/test-extension",
);
const ffmpeg = process.env.DIORAMA_FFMPEG ?? "ffmpeg";
const ffmpegCheck = spawnSync(ffmpeg, ["-version"], { encoding: "utf8" });
const integrationEnabled = process.env.DIORAMA_IT === "1" && ffmpegCheck.status === 0;

if (!integrationEnabled) {
  const reason = process.env.DIORAMA_IT !== "1"
    ? "DIORAMA_IT is not 1"
    : `ffmpeg is unavailable: ${ffmpegCheck.error?.message ?? ffmpegCheck.stderr}`;
  console.info(`cli record integration skipped (${reason})`);
}

function serveStage(): Promise<{ server: Server; url: string }> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html>
        <title>CLI stage</title>
        <button id="record">Record me</button>
        <script>
          document.querySelector("#record").addEventListener("click", (event) => {
            event.currentTarget.textContent = "Recorded";
          });
        </script>`);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({ server, url: `http://127.0.0.1:${port}/diorama-cli-stage` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}

describe.skipIf(!integrationEnabled)("CLI record integration", () => {
  it("records a local stage and extension popup to an mp4 and poster", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "diorama-cli-record-it-"));
    const outDir = join(tempDir, "out");
    const sheetPath = join(tempDir, "demo.beats.yaml");
    const { server, url } = await serveStage();
    try {
      await writeFile(sheetPath, `
version: 1
title: CLI integration
viewport: { width: 800, height: 600, scale: 1 }
extension:
  path: ${JSON.stringify(fixtureDir)}
  popup: { width: 400, height: 240 }
steps:
  - { verb: goto, url: ${JSON.stringify(url)} }
  - { verb: wait, selector: button }
  - { verb: click, selector: "text=Record me" }
  - { verb: openPopup }
  - { verb: hold, ms: 800 }
  - { verb: mark, name: end }
`, "utf8");

      const result = await recordCommand(
        [sheetPath, "--out", outDir],
        { log: () => {} },
      );
      expect((await stat(result.mp4Path)).size).toBeGreaterThan(0);
      expect((await stat(result.posterPath)).size).toBeGreaterThan(0);

      const ffprobe = process.env.DIORAMA_FFPROBE ?? "ffprobe";
      const probe = spawnSync(ffprobe, [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        result.mp4Path,
      ], { encoding: "utf8" });
      if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr}`);
      expect(Number(probe.stdout.trim())).toBeGreaterThanOrEqual(1);
    } finally {
      await closeServer(server);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);
});

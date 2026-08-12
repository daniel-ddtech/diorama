import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStudioServer } from "../src/server.js";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../engine/fixtures/test-extension",
);

function serverUrl(server: Server): string {
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}

async function canListenLocally(): Promise<boolean> {
  const probe = createServer();
  return await new Promise((resolvePromise) => {
    probe.once("error", () => resolvePromise(false));
    probe.listen(0, "127.0.0.1", () => {
      probe.close(() => resolvePromise(true));
    });
  });
}

const localHttpEnabled = await canListenLocally();
if (!localHttpEnabled) {
  console.info("studio HTTP tests skipped (loopback ports are unavailable)");
}

describe.skipIf(!localHttpEnabled)("studio server", () => {
  let stateDir: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "diorama-studio-test-"));
    server = createStudioServer({ port: 0, stateDir });
    await once(server, "listening");
    baseUrl = serverUrl(server);
  });

  afterEach(async () => {
    await closeServer(server);
    await rm(stateDir, { recursive: true, force: true });
  });

  it("rejects relative browse paths", async () => {
    const response = await fetch(`${baseUrl}/api/browse?path=relative`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "path must be absolute" });
  });

  it("reads the fixture extension manifest", async () => {
    const response = await fetch(
      `${baseUrl}/api/manifest?path=${encodeURIComponent(fixtureDir)}`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      name: "Diorama Fixture",
      version: "1.0.0",
      manifestVersion: 3,
      popup: "popup.html",
    });
  });

  it("validates beat sheet YAML and reports invalid input", async () => {
    const valid = await fetch(`${baseUrl}/api/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        yaml: `version: 1\ntitle: Minimal\nviewport: { width: 800, height: 600 }\nextension: { path: ${JSON.stringify(fixtureDir)} }\nsteps: []\n`,
      }),
    });
    await expect(valid.json()).resolves.toMatchObject({
      ok: true,
      title: "Minimal",
      stepCount: 0,
    });

    const invalid = await fetch(`${baseUrl}/api/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ yaml: "garbage" }),
    });
    await expect(invalid.json()).resolves.toMatchObject({ ok: false });
  });

  it("serves the single-file app", async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("diorama");
  });

  it("does not allow media path traversal", async () => {
    const response = await fetch(`${baseUrl}/media/..%2foutside/recording.mp4`);
    expect([400, 404]).toContain(response.status);
  });
});

const ffmpeg = process.env.DIORAMA_FFMPEG ?? "ffmpeg";
const ffmpegCheck = spawnSync(ffmpeg, ["-version"], { encoding: "utf8" });
const integrationEnabled = process.env.DIORAMA_IT === "1"
  && ffmpegCheck.status === 0
  && localHttpEnabled;

if (!integrationEnabled) {
  const reason = !localHttpEnabled
    ? "loopback ports are unavailable"
    : process.env.DIORAMA_IT !== "1"
    ? "DIORAMA_IT is not 1"
    : `ffmpeg is unavailable: ${ffmpegCheck.error?.message ?? ffmpegCheck.stderr}`;
  console.info(`studio record integration skipped (${reason})`);
}

function serveStage(): Promise<{ server: Server; url: string }> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><title>Studio stage</title><main>Ready</main>");
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise({ server, url: serverUrl(server) });
    });
  });
}

describe.skipIf(!integrationEnabled)("studio record integration", () => {
  it("records a fixture extension run into the studio run directory", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "diorama-studio-it-"));
    const studio = createStudioServer({ port: 0, stateDir });
    await once(studio, "listening");
    const baseUrl = serverUrl(studio);
    const stage = await serveStage();
    try {
      const yaml = `
version: 1
title: Studio integration
viewport: { width: 800, height: 600, scale: 1 }
extension:
  path: ${JSON.stringify(fixtureDir)}
  popup: { width: 400, height: 240 }
output:
  holdTailMs: 250
  endCard: false
steps:
  - { verb: goto, url: ${JSON.stringify(stage.url)} }
  - { verb: wait, selector: body }
  - { verb: openPopup }
  - { verb: hold, ms: 800 }
  - { verb: mark, name: end }
`;
      const response = await fetch(`${baseUrl}/api/record`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ yaml }),
      });
      expect(response.status).toBe(202);
      const { runId } = await response.json() as { runId: string };

      const deadline = Date.now() + 175_000;
      let completed = false;
      while (Date.now() < deadline) {
        const runs = await fetch(`${baseUrl}/api/runs`).then((result) => result.json()) as Array<{
          id: string;
          status: string;
          mp4: boolean;
        }>;
        const run = runs.find((entry) => entry.id === runId);
        if (run?.status === "error") throw new Error("studio recording reported an error");
        if (run?.status === "done" && run.mp4) {
          completed = true;
          break;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      }
      expect(completed).toBe(true);
      expect((await stat(join(stateDir, "runs", runId, "recording.mp4"))).size)
        .toBeGreaterThan(0);
    } finally {
      await closeServer(stage.server);
      await closeServer(studio);
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 180_000);
});

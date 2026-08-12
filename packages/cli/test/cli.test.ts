import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  initCommand,
  main,
  recordCommand,
  runDoctorChecks,
} from "../src/index.js";

describe("initCommand", () => {
  it("writes the starter sheet and refuses to overwrite it without --force", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "diorama-cli-init-"));
    try {
      const result = initCommand([tempDir], { log: () => {} });
      const starter = await readFile(result.sheetPath, "utf8");
      expect(starter).toContain("version: 1");
      expect(starter).toContain("url: https://example.com");
      expect(starter).toContain("verb: openPopup");
      expect(() => initCommand([tempDir], { log: () => {} }))
        .toThrow(/Refusing to overwrite.*--force/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("runDoctorChecks", () => {
  it("returns structured results with injectable filesystem and process checks", () => {
    const checks = runDoctorChecks({
      exists: () => false,
      spawn: (command) => ({ status: command === "ffprobe" ? 0 : 1 }),
      nodeVersion: "22.4.0",
    });

    expect(checks).toEqual([
      expect.objectContaining({ name: "chrome", ok: false, hint: expect.any(String) }),
      expect.objectContaining({ name: "ffmpeg", ok: false, hint: expect.any(String) }),
      expect.objectContaining({ name: "ffprobe", ok: true, hint: expect.any(String) }),
      expect.objectContaining({ name: "node", ok: true, hint: expect.any(String) }),
    ]);
  });
});

describe("recordCommand", () => {
  it("rejects a nonexistent beat sheet with a readable error", async () => {
    await expect(recordCommand([
      join(tmpdir(), "definitely-missing-diorama-sheet.yaml"),
    ], { log: () => {} })).rejects.toThrow(/Beat sheet not found:/);
  });
});

describe("mcp command", () => {
  it("points to the standalone server without introducing a package cycle", async () => {
    const messages: string[] = [];
    await expect(main(["mcp"], {
      log: (message) => messages.push(message),
      error: (message) => messages.push(message),
    })).resolves.toBe(0);
    expect(messages).toEqual([
      "Run the Diorama MCP stdio server with: diorama-mcp",
    ]);
  });
});

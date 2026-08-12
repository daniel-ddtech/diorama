import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  initCommand,
  main,
  parseRecordCommandArgs,
  recordCommand,
  runDoctorChecks,
} from "../src/index.js";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../engine/fixtures/test-extension",
);

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
  it("parses profile and seed storage overrides", () => {
    expect(parseRecordCommandArgs([
      "demo.beats.yaml",
      "--profile-dir",
      "./chrome-profile",
      "--seed-storage",
      "./storage.json",
    ])).toMatchObject({
      sheetPath: "demo.beats.yaml",
      profileDir: "./chrome-profile",
      seedStorage: "./storage.json",
    });
  });

  it("rejects a nonexistent beat sheet with a readable error", async () => {
    await expect(recordCommand([
      join(tmpdir(), "definitely-missing-diorama-sheet.yaml"),
    ], { log: () => {} })).rejects.toThrow(/Beat sheet not found:/);
  });

  it("reports missing and invalid seed storage files with their resolved paths", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "diorama-cli-seed-test-"));
    const sheetPath = join(tempDir, "demo.beats.yaml");
    const invalidSeedPath = join(tempDir, "invalid-storage.json");
    try {
      await writeFile(sheetPath, `
version: 1
title: seed path error
viewport: { width: 800, height: 600 }
extension:
  path: ${JSON.stringify(fixtureDir)}
steps: []
`, "utf8");

      await expect(recordCommand([
        sheetPath,
        "--seed-storage",
        "missing-storage.json",
      ], { log: () => {} })).rejects.toThrow(
        `Could not read seed storage file at ${join(tempDir, "missing-storage.json")}`,
      );

      await writeFile(invalidSeedPath, "{not valid JSON", "utf8");
      await expect(recordCommand([
        sheetPath,
        "--seed-storage",
        "invalid-storage.json",
      ], { log: () => {} })).rejects.toThrow(
        `Invalid seed storage JSON at ${invalidSeedPath}`,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects extension storage seeding without an extension block", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "diorama-cli-plain-seed-test-"));
    const sheetPath = join(tempDir, "demo.beats.yaml");
    try {
      await writeFile(sheetPath, `
version: 1
title: plain seed error
viewport: { width: 800, height: 600 }
profile: { seedStorage: ./storage.json }
steps: []
`, "utf8");

      await expect(recordCommand([sheetPath], { log: () => {} }))
        .rejects.toThrow(/seedStorage requires an extension block/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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

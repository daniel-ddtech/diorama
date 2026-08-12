import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveChromeBinary } from "../src/assets.js";
import { renderDemo } from "../src/render.js";

const ffmpeg = process.env.DIORAMA_FFMPEG ?? "ffmpeg";
const ffmpegCheck = spawnSync(ffmpeg, ["-version"], { encoding: "utf8" });
const integrationEnabled = process.env.DIORAMA_IT === "1" && ffmpegCheck.status === 0;

if (!integrationEnabled) {
  const reason = process.env.DIORAMA_IT !== "1"
    ? "DIORAMA_IT is not 1"
    : `ffmpeg is unavailable: ${ffmpegCheck.error?.message ?? ffmpegCheck.stderr}`;
  console.info(`compositor integration skipped (${reason})`);
}

// One-shot --screenshot hangs with --user-data-dir and produces nothing for
// data: URLs on CfT 148 (see assets.ts), write the HTML to a file, no profile.
function captureSolidImage(
  outputPath: string,
  scratchDir: string,
  width: number,
  height: number,
  color: string,
): void {
  const html = `<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:${color}}</style>`;
  const htmlPath = join(scratchDir, `fixture-${color.replace("#", "")}-${width}x${height}.html`);
  writeFileSync(htmlPath, html, "utf8");
  const result = spawnSync(resolveChromeBinary(), [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--disable-gpu",
    `--window-size=${width},${height}`,
    "--force-device-scale-factor=1",
    `--screenshot=${outputPath}`,
    pathToFileURL(htmlPath).href,
  ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) {
    const status = result.status === null ? `signal ${result.signal}` : `code ${result.status}`;
    throw new Error(`Chrome fixture screenshot failed (${status}): ${result.stderr}`);
  }
}

describe.skipIf(!integrationEnabled)("compositor integration", () => {
  it("renders a synthetic capture run to an mp4 and poster", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "diorama-compositor-it-"));
    const runDir = join(tempDir, "run");
    const stageDir = join(runDir, "stage");
    const popupDir = join(runDir, "popup");
    const profileDir = join(tempDir, "chrome-profile");
    const outPath = join(tempDir, "demo.mp4");
    const posterPath = join(tempDir, "poster.jpg");
    const startedAt = 1_800_000_000_000;

    try {
      await Promise.all([
        mkdir(stageDir, { recursive: true }),
        mkdir(popupDir, { recursive: true }),
        mkdir(profileDir, { recursive: true }),
      ]);
      ["#263238", "#37474f", "#455a64", "#546e7a"].forEach((color, index) => {
        captureSolidImage(
          join(stageDir, `${String(index).padStart(5, "0")}.jpg`),
          profileDir,
          160,
          90,
          color,
        );
      });
      ["#ff8a50", "#ff7043", "#f4511e"].forEach((color, index) => {
        captureSolidImage(
          join(popupDir, `${String(index).padStart(5, "0")}.jpg`),
          profileDir,
          60,
          40,
          color,
        );
      });
      const iconPath = join(tempDir, "icon.png");
      captureSolidImage(iconPath, profileDir, 18, 18, "#ff5c1c");

      await writeFile(join(runDir, "timing.json"), JSON.stringify({
        frames: [
          { name: "stage", times: [0, 250, 500, 750].map((time) => startedAt + time) },
          { name: "popup", times: [300, 550, 800].map((time) => startedAt + time) },
        ],
      }), "utf8");
      await writeFile(join(runDir, "events.json"), JSON.stringify({
        startedAt,
        events: [
          { verb: "openPopup", target: "popup", tStartMs: 200, tEndMs: 300 },
          { verb: "click", target: "popup", tStartMs: 450, tEndMs: 470, x: 20, y: 15 },
          { verb: "mark", target: "none", tStartMs: 700, tEndMs: 700, name: "poster" },
        ],
      }), "utf8");

      const rendered = await renderDemo({
        runDir,
        sheet: {
          title: "Synthetic compositor run",
          viewport: { width: 160, height: 90, scale: 1 },
          extension: { popup: { width: 60, height: 40 } },
        },
        iconPath,
        outPath,
        posterPath,
        fps: 20,
      });

      expect((await stat(rendered.mp4Path)).size).toBeGreaterThan(0);
      const ffprobe = process.env.DIORAMA_FFPROBE ?? "ffprobe";
      const probe = spawnSync(ffprobe, [
        "-v", "error",
        "-show_entries", "format=duration:stream=width,height",
        "-of", "json",
        rendered.mp4Path,
      ], { encoding: "utf8" });
      if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr}`);
      const metadata = JSON.parse(probe.stdout) as {
        streams: Array<{ width: number; height: number }>;
        format: { duration: string };
      };
      expect(Number(metadata.format.duration)).toBeGreaterThanOrEqual(0.8);
      expect(Number(metadata.format.duration)).toBeLessThanOrEqual(1.2);
      expect(metadata.streams[0]).toMatchObject({ width: 160, height: 190 });
      expect((await stat(rendered.posterPath)).size).toBeGreaterThan(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});

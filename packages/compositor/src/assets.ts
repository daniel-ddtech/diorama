import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TOOLBAR_HEIGHT } from "./plan.js";

const FRAMES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../frames",
);

export interface RenderFrameChromeOptions {
  theme: "dark";
  title: string;
  url: string;
  iconPath: string;
  width: number;
  height: number;
  scale: number;
}

export { resolveChromeBinary } from "@adlicio/diorama-engine";
import { resolveChromeBinary } from "@adlicio/diorama-engine";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function lastLines(value: string, count: number): string {
  return value.trimEnd().split(/\r?\n/).slice(-count).join("\n");
}

async function screenshotWithChrome(
  htmlPath: string,
  outputPath: string,
  width: number,
  height: number,
  scale: number,
): Promise<void> {
  // One-shot --screenshot mode hangs indefinitely when --user-data-dir is
  // passed (this Chrome build boots GCM sync services against the profile and
  // never exits), and silently produces nothing for data: URLs. So: file://
  // URLs only, and no profile flag, verified 2026-08-12 on CfT 148.
  const args = [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--disable-gpu",
    `--window-size=${width},${height}`,
    `--force-device-scale-factor=${scale}`,
    "--default-background-color=00000000",
    `--screenshot=${outputPath}`,
    pathToFileURL(htmlPath).href,
  ];

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(resolveChromeBinary(), args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      reject(new Error(`Chrome screenshot failed to start: ${error.message}`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const status = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
      reject(new Error(
        `Chrome screenshot failed (${status}):\n${lastLines(stderr, 30)}`,
      ));
    });
  });
}

async function renderHtmlScreenshot(
  html: string,
  width: number,
  height: number,
  scale: number,
): Promise<Buffer> {
  if (![width, height, scale].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Screenshot width, height, and scale must be positive");
  }
  const tempDir = await mkdtemp(join(tmpdir(), "diorama-compositor-"));
  const htmlPath = join(tempDir, "asset.html");
  const outputPath = join(tempDir, "asset.png");
  try {
    await writeFile(htmlPath, html, "utf8");
    await screenshotWithChrome(htmlPath, outputPath, width, height, scale);
    return await readFile(outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function renderFrameChrome(
  options: RenderFrameChromeOptions,
): Promise<Buffer> {
  const templatePath = join(FRAMES_DIR, `${options.theme}.html`);
  const template = await readFile(templatePath, "utf8");
  const replacements: Record<string, string> = {
    TITLE: escapeHtml(options.title),
    URL: escapeHtml(options.url),
    ICON_SRC: escapeHtml(pathToFileURL(resolve(options.iconPath)).href),
    WIDTH: String(options.width),
    HEIGHT: String(options.height),
    TOOLBAR_H: String(TOOLBAR_HEIGHT),
  };
  const html = Object.entries(replacements).reduce(
    (result, [name, value]) => result.replaceAll(`{{${name}}}`, value),
    template,
  );
  return renderHtmlScreenshot(
    html,
    options.width,
    options.height,
    options.scale,
  );
}

export async function renderEndCard(
  width: number,
  height: number,
  scale: number,
): Promise<Buffer> {
  const template = await readFile(join(FRAMES_DIR, "endcard.html"), "utf8");
  const html = template
    .replaceAll("{{WIDTH}}", String(width))
    .replaceAll("{{HEIGHT}}", String(height));
  return renderHtmlScreenshot(html, width, height, scale);
}

export async function renderCursorPng(scale: number): Promise<Buffer> {
  const cursorUrl = pathToFileURL(join(FRAMES_DIR, "cursor.svg")).href;
  const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { width: 28px; height: 28px; margin: 0; overflow: hidden; background: transparent; }
  img { display: block; width: 21px; height: 28px; }
</style>
<img src="${escapeHtml(cursorUrl)}" alt="">`;
  return renderHtmlScreenshot(html, 28, 28, scale);
}

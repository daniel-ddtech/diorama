import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { renderCursorPng, renderFrameChrome } from "./assets.js";
import {
  concatFileFor,
  cursorPath,
  ffmpegArgs,
  popupWindow,
  TOOLBAR_HEIGHT,
  type CompositorEvent,
  type CursorSegment,
} from "./plan.js";

interface CaptureStream {
  name: string;
  times: number[];
}

interface TimingFile {
  frames: CaptureStream[];
}

interface EventFile {
  events: CompositorEvent[];
  startedAt?: number;
}

export interface RenderSheet {
  title: string;
  viewport: {
    width: number;
    height: number;
    scale: number;
  };
  extension: {
    popup: {
      width: number;
      height: number;
    };
  };
}

export interface RenderDemoOptions {
  runDir: string;
  sheet: RenderSheet;
  iconPath: string;
  outPath: string;
  posterPath: string;
  fps?: number;
}

export interface RenderDemoResult {
  mp4Path: string;
  posterPath: string;
  durationMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTiming(value: unknown): TimingFile {
  if (!isRecord(value) || !Array.isArray(value.frames)) {
    throw new Error("timing.json must contain a frames array");
  }
  const frames = value.frames.map((entry): CaptureStream => {
    if (
      !isRecord(entry)
      || typeof entry.name !== "string"
      || !Array.isArray(entry.times)
      || !entry.times.every((time) => typeof time === "number" && Number.isFinite(time))
    ) {
      throw new Error("timing.json has an invalid capture stream");
    }
    return { name: entry.name, times: entry.times };
  });
  return { frames };
}

function isCompositorEvent(value: unknown): value is CompositorEvent {
  return isRecord(value)
    && typeof value.verb === "string"
    && typeof value.target === "string"
    && typeof value.tStartMs === "number"
    && typeof value.tEndMs === "number";
}

function parseEvents(value: unknown): EventFile {
  const rawEvents = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.events)
      ? value.events
      : undefined;
  if (!rawEvents || !rawEvents.every(isCompositorEvent)) {
    throw new Error("events.json must be an event array or contain an events array");
  }
  const startedAt = isRecord(value) && typeof value.startedAt === "number"
    ? value.startedAt
    : undefined;
  return {
    events: rawEvents,
    ...(startedAt === undefined ? {} : { startedAt }),
  };
}

function streamNamed(timing: TimingFile, name: string): CaptureStream {
  const stream = timing.frames.find((candidate) => candidate.name === name);
  if (!stream) throw new Error(`timing.json does not contain a ${name} stream`);
  if (stream.times.length === 0) throw new Error(`${name} contains no captured frames`);
  return stream;
}

function frameTailMs(times: number[], fps: number): number {
  for (let index = times.length - 1; index > 0; index -= 1) {
    const delta = times[index]! - times[index - 1]!;
    if (delta > 0) return delta;
  }
  return 1_000 / fps;
}

function scaledSegments(segments: CursorSegment[], scale: number): CursorSegment[] {
  return segments.map((segment) => ({
    t0: segment.t0,
    t1: segment.t1,
    x0: segment.x0 * scale,
    y0: segment.y0 * scale,
    x1: segment.x1 * scale,
    y1: segment.y1 * scale,
  }));
}

function lastLines(value: string, count: number): string {
  return value.trimEnd().split(/\r?\n/).slice(-count).join("\n");
}

async function runBinary(binary: string, args: string[], label: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      reject(new Error(`${label} failed to start: ${error.message}`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const status = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
      reject(new Error(`${label} failed (${status}):\n${lastLines(stderr, 30)}`));
    });
  });
}

export async function renderDemo(options: RenderDemoOptions): Promise<RenderDemoResult> {
  const fps = options.fps ?? 30;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("fps must be positive");
  const { viewport } = options.sheet;
  if (![viewport.width, viewport.height, viewport.scale].every(
    (value) => Number.isFinite(value) && value > 0,
  )) {
    throw new Error("Viewport width, height, and scale must be positive");
  }

  const runDir = resolve(options.runDir);
  const mp4Path = resolve(options.outPath);
  const posterPath = resolve(options.posterPath);
  const timing = parseTiming(JSON.parse(await readFile(join(runDir, "timing.json"), "utf8")));
  const eventFile = parseEvents(JSON.parse(await readFile(join(runDir, "events.json"), "utf8")));
  const stage = streamNamed(timing, "stage");
  const popup = streamNamed(timing, "popup");
  const t0 = eventFile.startedAt ?? stage.times[0]!;
  const stageTailMs = frameTailMs(stage.times, fps);
  const durationMs = Math.max(0, stage.times[stage.times.length - 1]! - t0)
    + stageTailMs;
  const popupLifetime = popupWindow(eventFile.events);

  const popupOrigin = {
    x: viewport.width - options.sheet.extension.popup.width - 24,
    y: TOOLBAR_HEIGHT + 16,
  };
  const cursorSegments = cursorPath(eventFile.events, {
    enterMs: 0,
    stageOrigin: { x: 0, y: TOOLBAR_HEIGHT },
    popupOrigin,
  });
  const outputCssHeight = viewport.height + TOOLBAR_HEIGHT;
  const outputWidth = Math.round(viewport.width * viewport.scale);
  const outputHeight = Math.round(outputCssHeight * viewport.scale);

  const gotoUrl = [...eventFile.events].reverse()
    .find((event) => event.verb === "goto" && event.url)?.url ?? "";
  const [chromePng, cursorPng] = await Promise.all([
    renderFrameChrome({
      theme: "dark",
      title: options.sheet.title,
      url: gotoUrl,
      iconPath: options.iconPath,
      width: viewport.width,
      height: outputCssHeight,
      scale: viewport.scale,
    }),
    renderCursorPng(viewport.scale),
  ]);

  await Promise.all([
    mkdir(dirname(mp4Path), { recursive: true }),
    mkdir(dirname(posterPath), { recursive: true }),
  ]);
  const chromePath = join(runDir, "frame-chrome.png");
  const cursorPngPath = join(runDir, "cursor.png");
  const stageConcatPath = join(runDir, "stage.ffconcat");
  const popupConcatPath = join(runDir, "popup.ffconcat");
  await Promise.all([
    writeFile(chromePath, chromePng),
    writeFile(cursorPngPath, cursorPng),
    writeFile(
      stageConcatPath,
      concatFileFor(stage.times, join(runDir, "stage"), t0, stageTailMs),
      "utf8",
    ),
    writeFile(
      popupConcatPath,
      concatFileFor(
        popup.times,
        join(runDir, "popup"),
        popup.times[0]!,
        frameTailMs(popup.times, fps),
      ),
      "utf8",
    ),
  ]);

  const ffmpeg = process.env.DIORAMA_FFMPEG ?? "ffmpeg";
  await runBinary(ffmpeg, ffmpegArgs({
    frameChromePath: chromePath,
    stageConcatPath,
    popupConcatPath,
    cursorPath: cursorPngPath,
    popup: {
      x: popupOrigin.x * viewport.scale,
      y: popupOrigin.y * viewport.scale,
      ...popupLifetime,
    },
    cursorSegments: scaledSegments(cursorSegments, viewport.scale),
    width: outputWidth,
    height: outputHeight,
    stageY: TOOLBAR_HEIGHT * viewport.scale,
    fps,
    durationMs,
    mp4Path,
  }), "ffmpeg encode");

  const lastMark = [...eventFile.events].reverse()
    .find((event) => event.verb === "mark");
  const requestedPosterMs = lastMark?.tStartMs ?? durationMs * 0.8;
  const lastUsableMs = Math.max(0, durationMs - 1_000 / fps);
  const posterMs = Math.min(Math.max(0, requestedPosterMs), lastUsableMs);
  await runBinary(ffmpeg, [
    "-y",
    "-i", mp4Path,
    "-ss", String(posterMs / 1_000),
    "-frames:v", "1",
    "-q:v", "2",
    posterPath,
  ], "ffmpeg poster extraction");

  return { mp4Path, posterPath, durationMs };
}

import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  cursorHotspotOffset,
  renderCursorPng,
  renderEndCard,
  renderFrameChrome,
  renderRippleFrames,
} from "./assets.js";
import {
  cameraTrack,
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
  frame?: {
    theme: string;
    themePath?: string;
    url?: string;
    title?: string;
  };
  cursor?: {
    scale: number;
    ripple: boolean;
    shadow: boolean;
  };
  viewport: {
    width: number;
    height: number;
    scale: number;
  };
  extension: {
    popup: {
      width: number;
      height: number;
      position?: "right" | "left";
    };
  };
  output?: {
    posterAt?: string | number;
    formats?: OutputFormat[];
  };
}

export interface EndCardOptions {
  title: string;
  subtitle?: string;
}

export interface OutputFormat {
  name: string;
  width: number;
  height: number;
  crf: number;
  fit: "cover" | "contain";
}

export interface RenderDemoOptions {
  runDir: string;
  sheet: RenderSheet;
  iconPath: string;
  outPath: string;
  posterPath: string;
  fps?: number;
  /** Append the "Recorded with diorama" card (1.6s). Callers decide; the CLI
   * defaults it on via the beat sheet's output.endCard. */
  endCard?: boolean | EndCardOptions;
  log?: (message: string) => void;
}

export interface RenderDemoResult {
  mp4Path: string;
  posterPath: string;
  durationMs: number;
  formats: Array<{ name: string; path: string }>;
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

function scaledSegments(
  segments: CursorSegment[],
  scale: number,
  hotspot: { x: number; y: number },
): CursorSegment[] {
  return segments.map((segment) => ({
    t0: segment.t0,
    t1: segment.t1,
    x0: (segment.x0 - hotspot.x) * scale,
    y0: (segment.y0 - hotspot.y) * scale,
    x1: (segment.x1 - hotspot.x) * scale,
    y1: (segment.y1 - hotspot.y) * scale,
  }));
}

function titleSlug(title: string): string {
  return title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "demo";
}

function requestedPosterMs(
  posterAt: string | number | undefined,
  events: CompositorEvent[],
  durationMs: number,
): number {
  if (typeof posterAt === "number") return posterAt;
  const marks = events.filter((event) => event.verb === "mark" && event.name);
  if (typeof posterAt === "string") {
    const requested = marks.find((event) => event.name === posterAt);
    if (!requested) {
      const available = marks.map((event) => event.name).join(", ") || "(none)";
      throw new Error(
        `Poster mark ${JSON.stringify(posterAt)} not found. Available marks: ${available}`,
      );
    }
    return requested.tStartMs;
  }
  return marks.at(-1)?.tStartMs ?? durationMs * 0.8;
}

function outputFormatFilter(format: OutputFormat): string {
  if (format.fit === "contain") {
    return `scale=${format.width}:${format.height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${format.width}:${format.height}:(ow-iw)/2:(oh-ih)/2:color=0x0c0c0f,setsar=1`;
  }
  return `scale=${format.width}:${format.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${format.width}:${format.height}:(iw-ow)/2:(ih-oh)/2,setsar=1`;
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
  const popupStream = timing.frames.find((stream) => stream.name === "popup");
  const popup = popupStream && popupStream.times.length > 0 ? popupStream : undefined;
  const t0 = eventFile.startedAt ?? stage.times[0]!;
  const stageTailMs = frameTailMs(stage.times, fps);
  const durationMs = Math.max(0, stage.times[stage.times.length - 1]! - t0)
    + stageTailMs;

  const openPopupEvent = eventFile.events.find((event) => event.verb === "openPopup");
  const configuredPopup = options.sheet.extension.popup;
  const popupSize = {
    width: Number.isFinite(openPopupEvent?.width) && openPopupEvent!.width! > 0
      ? openPopupEvent!.width!
      : configuredPopup.width,
    height: Number.isFinite(openPopupEvent?.height) && openPopupEvent!.height! > 0
      ? openPopupEvent!.height!
      : configuredPopup.height,
  };
  const popupPosition = openPopupEvent?.position ?? configuredPopup.position ?? "right";
  const popupOrigin = {
    x: popupPosition === "left" ? 24 : viewport.width - popupSize.width - 24,
    y: TOOLBAR_HEIGHT + 16,
  };
  const cursorOptions = options.sheet.cursor ?? {
    scale: 1,
    ripple: false,
    shadow: false,
  };
  const cursorSegments = cursorPath(eventFile.events, {
    enterMs: 0,
    stageOrigin: { x: 0, y: TOOLBAR_HEIGHT },
    popupOrigin,
  });
  const outputCssHeight = viewport.height + TOOLBAR_HEIGHT;
  const outputWidth = Math.round(viewport.width * viewport.scale);
  const outputHeight = Math.round(outputCssHeight * viewport.scale);
  const cameraSegments = cameraTrack(eventFile.events, {
    width: viewport.width,
    height: viewport.height,
    toolbarH: TOOLBAR_HEIGHT,
    popupOrigin,
    popupSize,
  });

  const allRippleEvents = cursorOptions.ripple
    ? eventFile.events.filter((event) => (
      event.verb === "click"
      && Number.isFinite(event.x)
      && Number.isFinite(event.y)
    ))
    : [];
  const rippleEvents = allRippleEvents.slice(0, 24);
  if (allRippleEvents.length > rippleEvents.length) {
    (options.log ?? console.info)(
      `Click ripples are capped at 24; skipped ${allRippleEvents.length - rippleEvents.length} extra clicks`,
    );
  }
  const rippleDir = join(runDir, "ripple");
  const rippleFramesPath = join(rippleDir, "%02d.png");
  const ripples = rippleEvents.map((event) => {
    const origin = event.target === "popup"
      ? popupOrigin
      : { x: 0, y: TOOLBAR_HEIGHT };
    return {
      framesPath: rippleFramesPath,
      tStartMs: event.tStartMs,
      x: (event.x! + origin.x - 32) * viewport.scale,
      y: (event.y! + origin.y - 32) * viewport.scale,
    };
  });

  const gotoUrl = [...eventFile.events].reverse()
    .find((event) => event.verb === "goto" && event.url)?.url ?? "";
  const frame = options.sheet.frame ?? { theme: "dark" };
  const [chromePng, cursorPng, rippleFrames] = await Promise.all([
    renderFrameChrome({
      theme: frame.theme,
      ...(frame.themePath === undefined ? {} : { themePath: frame.themePath }),
      title: frame.title ?? options.sheet.title,
      url: frame.url ?? gotoUrl,
      iconPath: options.iconPath,
      width: viewport.width,
      height: outputCssHeight,
      scale: viewport.scale,
    }),
    renderCursorPng(viewport.scale, cursorOptions),
    rippleEvents.length > 0 ? renderRippleFrames(viewport.scale) : Promise.resolve([]),
  ]);

  await Promise.all([
    mkdir(dirname(mp4Path), { recursive: true }),
    mkdir(dirname(posterPath), { recursive: true }),
    ...(rippleFrames.length > 0 ? [mkdir(rippleDir, { recursive: true })] : []),
  ]);
  const chromePath = join(runDir, "frame-chrome.png");
  const cursorPngPath = join(runDir, "cursor.png");
  const stageConcatPath = join(runDir, "stage.ffconcat");
  const popupConcatPath = join(runDir, "popup.ffconcat");
  await Promise.all([
    writeFile(chromePath, chromePng),
    writeFile(cursorPngPath, cursorPng),
    ...rippleFrames.map((framePng, index) => writeFile(
      join(rippleDir, `${String(index).padStart(2, "0")}.png`),
      framePng,
    )),
    writeFile(
      stageConcatPath,
      concatFileFor(stage.times, join(runDir, "stage"), t0, stageTailMs),
      "utf8",
    ),
    ...(popup ? [writeFile(
      popupConcatPath,
      concatFileFor(
        popup.times,
        join(runDir, "popup"),
        popup.times[0]!,
        frameTailMs(popup.times, fps),
      ),
      "utf8",
    )] : []),
  ]);

  const ffmpeg = process.env.DIORAMA_FFMPEG ?? "ffmpeg";
  const mainArgs = ffmpegArgs({
    frameChromePath: chromePath,
    stageConcatPath,
    cursorPath: cursorPngPath,
    ...(popup ? {
      popupConcatPath,
      popup: {
        x: popupOrigin.x * viewport.scale,
        y: popupOrigin.y * viewport.scale,
        // Anchor the popup stream at its first CAPTURED frame, not the
        // openPopup event: early popup screenshots can fail while the target
        // navigates, and shifting the stream to the event time would play the
        // captured content early by exactly that gap.
        ...((): { enterMs: number; exitMs: number | null } => {
          const window = popupWindow(eventFile.events);
          const firstFrameMs = popup.times[0]! - t0;
          return { ...window, enterMs: Math.max(window.enterMs, firstFrameMs) };
        })(),
      },
    } : {}),
    cursorSegments: scaledSegments(
      cursorSegments,
      viewport.scale,
      cursorHotspotOffset(cursorOptions),
    ),
    cameraSegments,
    ripples,
    width: outputWidth,
    height: outputHeight,
    stageY: TOOLBAR_HEIGHT * viewport.scale,
    fps,
    durationMs,
    mp4Path,
  });
  if (process.env.DIORAMA_DEBUG_FFMPEG) {
    console.error("[diorama] ffmpeg filter graph:\n" + (mainArgs[mainArgs.indexOf("-filter_complex") + 1] ?? "(none)"));
  }
  await runBinary(ffmpeg, mainArgs, "ffmpeg encode");

  const posterRequestMs = requestedPosterMs(
    options.sheet.output?.posterAt,
    eventFile.events,
    durationMs,
  );
  const lastUsableMs = Math.max(0, durationMs - 1_000 / fps);
  const posterMs = Math.min(Math.max(0, posterRequestMs), lastUsableMs);
  await runBinary(ffmpeg, [
    "-y",
    "-i", mp4Path,
    "-ss", String(posterMs / 1_000),
    "-frames:v", "1",
    "-q:v", "2",
    posterPath,
  ], "ffmpeg poster extraction");

  let finalDurationMs = durationMs;
  if (options.endCard) {
    const cardMs = 1_600;
    const cardPng = await renderEndCard(
      viewport.width,
      outputCssHeight,
      viewport.scale,
      typeof options.endCard === "object" ? options.endCard : undefined,
    );
    const cardPath = join(runDir, "endcard.png");
    const withCardPath = join(runDir, "with-endcard.mp4");
    await writeFile(cardPath, cardPng);
    await runBinary(ffmpeg, [
      "-y",
      "-i", mp4Path,
      "-loop", "1", "-t", String(cardMs / 1_000), "-i", cardPath,
      "-filter_complex",
      `[1:v]format=yuv420p,fps=${fps},fade=in:st=0:d=0.3,scale=${outputWidth}:${outputHeight}[card];[0:v][card]concat=n=2:v=1:a=0[out]`,
      "-map", "[out]",
      "-an",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      withCardPath,
    ], "ffmpeg end card");
    await copyFile(withCardPath, mp4Path);
    finalDurationMs += cardMs;
  }

  const formats: RenderDemoResult["formats"] = [];
  for (const format of options.sheet.output?.formats ?? []) {
    const formatPath = join(
      dirname(mp4Path),
      `${titleSlug(options.sheet.title)}-${format.name}.mp4`,
    );
    await runBinary(ffmpeg, [
      "-y",
      "-i", mp4Path,
      "-vf", outputFormatFilter(format),
      "-an",
      "-c:v", "libx264",
      "-crf", String(format.crf),
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      formatPath,
    ], `ffmpeg format ${format.name}`);
    formats.push({ name: format.name, path: formatPath });
  }

  return { mp4Path, posterPath, durationMs: finalDurationMs, formats };
}

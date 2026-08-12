export const TOOLBAR_HEIGHT = 100;

export interface CompositorEvent {
  verb: string;
  target: string;
  tStartMs: number;
  tEndMs: number;
  x?: number;
  y?: number;
  name?: string;
  url?: string;
  zoom?: number;
  focus?: "page" | "popup" | "none";
  ms?: number;
  width?: number;
  height?: number;
  position?: "right" | "left";
}

export interface PopupWindow {
  enterMs: number;
  exitMs: number | null;
}

export interface Point {
  x: number;
  y: number;
}

export interface CursorSegment {
  t0: number;
  t1: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface CursorPathOptions {
  enterMs: number;
  popupOrigin?: Point;
  stageOrigin?: Point;
}

export interface CameraTrackOptions {
  width: number;
  height: number;
  toolbarH: number;
  popupOrigin?: Point;
  popupSize?: {
    width: number;
    height: number;
  };
}

export interface CameraSegment {
  t0: number;
  t1: number;
  zoom0: number;
  zoom1: number;
  focusX0: number;
  focusY0: number;
  focusX1: number;
  focusY1: number;
}

export interface RippleOverlay {
  framesPath: string;
  tStartMs: number;
  x: number;
  y: number;
}

export interface PopupOverlay extends PopupWindow {
  x: number;
  y: number;
}

export interface FfmpegPlan {
  frameChromePath: string;
  stageConcatPath: string;
  popupConcatPath?: string;
  cursorPath: string;
  popup?: PopupOverlay;
  cursorSegments: CursorSegment[];
  cameraSegments?: CameraSegment[];
  ripples?: RippleOverlay[];
  width: number;
  height: number;
  stageY?: number;
  fps: number;
  durationMs: number;
  mp4Path: string;
}

/** Map fixed-rate output ticks to a monotonically captured input sequence. */
export function mapFramesToTicks(
  times: number[],
  t0: number,
  fps: number,
  durationMs: number,
): number[] {
  if (times.length === 0) throw new Error("Cannot map an empty frame sequence");
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("fps must be positive");
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error("durationMs must be non-negative");
  }
  for (let index = 1; index < times.length; index += 1) {
    if (times[index]! < times[index - 1]!) {
      throw new Error("Frame timestamps must be monotonic");
    }
  }

  const tickCount = Math.ceil(durationMs * fps / 1_000);
  const result: number[] = [];
  let frameIndex = 0;
  for (let tick = 0; tick < tickCount; tick += 1) {
    const tickTime = t0 + tick * 1_000 / fps;
    while (
      frameIndex + 1 < times.length
      && times[frameIndex + 1]! <= tickTime
    ) {
      frameIndex += 1;
    }
    result.push(frameIndex);
  }
  return result;
}

/** Resolve the first popup lifetime in an executor event log. */
export function popupWindow(events: CompositorEvent[]): PopupWindow {
  const openIndex = events.findIndex((event) => event.verb === "openPopup");
  if (openIndex === -1) return { enterMs: 0, exitMs: null };

  const open = events[openIndex]!;
  const close = events.slice(openIndex + 1)
    .find((event) => event.verb === "closePopup");
  return {
    enterMs: open.tEndMs,
    exitMs: close?.tEndMs ?? null,
  };
}

const CURSOR_VERBS = new Set(["click", "hover", "type", "scroll"]);

function cubicEaseInOut(value: number): number {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - ((-2 * value + 2) ** 3) / 2;
}

/**
 * Build a seek-safe, piecewise-linear approximation of an eased cursor path.
 * Coordinates remain CSS pixels; callers scale them once when planning output.
 */
export function cursorPath(
  events: CompositorEvent[],
  options: CursorPathOptions,
): CursorSegment[] {
  const popupOrigin = options.popupOrigin ?? { x: 0, y: 0 };
  const stageOrigin = options.stageOrigin ?? { x: 0, y: 0 };
  const points = events.flatMap((event): Array<Point & { t: number }> => {
    if (
      !CURSOR_VERBS.has(event.verb)
      || !Number.isFinite(event.x)
      || !Number.isFinite(event.y)
    ) {
      return [];
    }
    const origin = event.target === "popup" ? popupOrigin : stageOrigin;
    return [{
      t: Math.max(options.enterMs, event.tStartMs),
      x: event.x! + origin.x,
      y: event.y! + origin.y,
    }];
  });

  if (points.length === 0) return [];
  if (points.length === 1) {
    const point = points[0]!;
    return [{
      t0: options.enterMs,
      t1: Math.max(options.enterMs + 1, point.t),
      x0: point.x,
      y0: point.y,
      x1: point.x,
      y1: point.y,
    }];
  }

  const segments: CursorSegment[] = [];
  for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) {
    const start = points[pointIndex]!;
    const end = points[pointIndex + 1]!;
    const pairEnd = Math.max(start.t + 1, end.t);
    for (let part = 0; part < 3; part += 1) {
      const u0 = part / 3;
      const u1 = (part + 1) / 3;
      const eased0 = cubicEaseInOut(u0);
      const eased1 = cubicEaseInOut(u1);
      segments.push({
        t0: start.t + (pairEnd - start.t) * u0,
        t1: start.t + (pairEnd - start.t) * u1,
        x0: start.x + (end.x - start.x) * eased0,
        y0: start.y + (end.y - start.y) * eased0,
        x1: start.x + (end.x - start.x) * eased1,
        y1: start.y + (end.y - start.y) * eased1,
      });
    }
  }
  return segments;
}

/** Build eased camera zoom/focus segments in normalized output coordinates. */
export function cameraTrack(
  events: CompositorEvent[],
  options: CameraTrackOptions,
): CameraSegment[] {
  const outputHeight = options.height + options.toolbarH;
  if (![options.width, options.height, outputHeight].every(
    (value) => Number.isFinite(value) && value > 0,
  )) {
    throw new Error("Camera track dimensions must be positive");
  }

  let zoom = 1;
  let focusX = 0.5;
  let focusY = 0.5;
  const segments: CameraSegment[] = [];
  for (const event of events) {
    if (event.verb !== "camera" || !Number.isFinite(event.zoom)) continue;

    const nextZoom = Math.min(2.5, Math.max(1, event.zoom!));
    let nextFocusX = focusX;
    let nextFocusY = focusY;
    if (event.focus === "page") {
      nextFocusX = 0.5;
      nextFocusY = (options.toolbarH + options.height / 2) / outputHeight;
    } else if (
      event.focus === "popup"
      && options.popupOrigin !== undefined
      && options.popupSize !== undefined
    ) {
      nextFocusX = (options.popupOrigin.x + options.popupSize.width / 2)
        / options.width;
      nextFocusY = (options.popupOrigin.y + options.popupSize.height / 2)
        / outputHeight;
    }

    const durationMs = Number.isFinite(event.ms)
      ? Math.max(0, event.ms!)
      : Math.max(0, event.tEndMs - event.tStartMs);
    for (let part = 0; part < 3; part += 1) {
      const u0 = part / 3;
      const u1 = (part + 1) / 3;
      const eased0 = cubicEaseInOut(u0);
      const eased1 = cubicEaseInOut(u1);
      segments.push({
        t0: event.tStartMs + durationMs * u0,
        t1: event.tStartMs + durationMs * u1,
        zoom0: zoom + (nextZoom - zoom) * eased0,
        zoom1: zoom + (nextZoom - zoom) * eased1,
        focusX0: focusX + (nextFocusX - focusX) * eased0,
        focusY0: focusY + (nextFocusY - focusY) * eased0,
        focusX1: focusX + (nextFocusX - focusX) * eased1,
        focusY1: focusY + (nextFocusY - focusY) * eased1,
      });
    }
    zoom = nextZoom;
    focusX = nextFocusX;
    focusY = nextFocusY;
  }
  return segments;
}

function ffconcatQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function decimal(value: number, digits = 6): string {
  const fixed = value.toFixed(digits);
  return fixed.replace(/\.?0+$/, "") || "0";
}

/** Build an ffconcat manifest for an engine capture directory. */
export function concatFileFor(
  times: number[],
  framesDir: string,
  t0: number,
  tailMs: number,
): string {
  if (times.length === 0) throw new Error("Cannot concatenate an empty frame sequence");
  if (!Number.isFinite(tailMs) || tailMs < 0) throw new Error("tailMs must be non-negative");
  for (let index = 1; index < times.length; index += 1) {
    if (times[index]! < times[index - 1]!) {
      throw new Error("Frame timestamps must be monotonic");
    }
  }

  let startIndex = 0;
  for (let index = 1; index < times.length && times[index]! <= t0; index += 1) {
    startIndex = index;
  }
  const baseDir = framesDir.replace(/[\\/]$/, "");
  const lines = ["ffconcat version 1.0"];
  let lastPath = "";
  for (let index = startIndex; index < times.length; index += 1) {
    lastPath = `${baseDir}/${String(index).padStart(5, "0")}.jpg`;
    const next = times[index + 1];
    // At the run boundary, hold the clamped frame until the next capture.
    const intervalStart = index === startIndex ? t0 : times[index]!;
    const durationMs = next === undefined ? tailMs : Math.max(0, next - intervalStart);
    lines.push(`file ${ffconcatQuote(lastPath)}`);
    lines.push(`duration ${decimal(durationMs / 1_000)}`);
  }

  // The concat demuxer only applies the final duration when its file is repeated.
  lines.push(`file ${ffconcatQuote(lastPath)}`);
  return `${lines.join("\n")}\n`;
}

function linearExpression(
  segment: CursorSegment,
  startKey: "x0" | "y0",
  endKey: "x1" | "y1",
): string {
  const t0 = segment.t0 / 1_000;
  const t1 = segment.t1 / 1_000;
  const start = segment[startKey];
  const end = segment[endKey];
  if (t1 <= t0 || start === end) return decimal(end);
  return `${decimal(start)}+(${decimal(end - start)})*(t-${decimal(t0)})/${decimal(t1 - t0)}`;
}

function cursorExpression(
  segments: CursorSegment[],
  startKey: "x0" | "y0",
  endKey: "x1" | "y1",
): string {
  if (segments.length === 0) return "-100";
  let expression = decimal(segments[segments.length - 1]![endKey]);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    expression = `if(lt(t,${decimal(segment.t1 / 1_000)}),${linearExpression(segment, startKey, endKey)},${expression})`;
  }
  const first = segments[0]!;
  return `if(lt(t,${decimal(first.t0 / 1_000)}),${decimal(first[startKey])},${expression})`;
}

function cameraLinearExpression(
  segment: CameraSegment,
  startKey: "zoom0" | "focusX0" | "focusY0",
  endKey: "zoom1" | "focusX1" | "focusY1",
  timeVar: string,
): string {
  const t0 = segment.t0 / 1_000;
  const t1 = segment.t1 / 1_000;
  const start = segment[startKey];
  const end = segment[endKey];
  if (t1 <= t0 || start === end) return decimal(end);
  return `${decimal(start)}+(${decimal(end - start)})*(${timeVar}-${decimal(t0)})/${decimal(t1 - t0)}`;
}

function cameraExpression(
  segments: CameraSegment[],
  startKey: "zoom0" | "focusX0" | "focusY0",
  endKey: "zoom1" | "focusX1" | "focusY1",
  timeVar = "t",
): string {
  if (segments.length === 0) {
    return startKey === "zoom0" ? "1" : "0.5";
  }
  let expression = decimal(segments[segments.length - 1]![endKey]);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    expression = `if(lt(${timeVar},${decimal(segment.t0 / 1_000)}),${decimal(segment[startKey])},if(lt(${timeVar},${decimal(segment.t1 / 1_000)}),${cameraLinearExpression(segment, startKey, endKey, timeVar)},${expression}))`;
  }
  return expression;
}

/** Assemble argv for a stage-led, finite FFmpeg filter graph. */
export function ffmpegArgs(plan: FfmpegPlan): string[] {
  const stageY = plan.stageY ?? 0;
  const contentHeight = plan.height - stageY;
  if (contentHeight <= 0) throw new Error("The toolbar must be shorter than the output");
  if ((plan.popupConcatPath === undefined) !== (plan.popup === undefined)) {
    throw new Error("popupConcatPath and popup must be provided together");
  }
  const cursorX = cursorExpression(plan.cursorSegments, "x0", "x1");
  const cursorY = cursorExpression(plan.cursorSegments, "y0", "y1");
  const cameraSegments = plan.cameraSegments ?? [];
  const ripples = plan.ripples ?? [];
  const filter = [
    `[1:v]fps=${decimal(plan.fps)},scale=${plan.width}:${contentHeight}:flags=lanczos,pad=${plan.width}:${plan.height}:0:${stageY}:color=0x0c0c0f[base]`,
    "[0:v]format=rgba[chrome]",
    "[base][chrome]overlay=0:0:eof_action=repeat:shortest=0[framed]",
  ];
  let cursorInput = 2;
  let cursorBase = "framed";
  if (plan.popup && plan.popupConcatPath) {
    const enter = decimal(plan.popup.enterMs / 1_000);
    const exit = plan.popup.exitMs === null
      ? "1e9"
      : decimal(plan.popup.exitMs / 1_000);
    filter.push(
      `[2:v]format=yuva420p,fade=in:alpha=1:st=0:d=0.2,setpts=PTS+${enter}/TB[popup]`,
      `[framed][popup]overlay=${decimal(plan.popup.x)}:${decimal(plan.popup.y)}:enable='between(t,${enter},${exit})':eof_action=repeat:shortest=0[withpopup]`,
    );
    cursorInput = 3;
    cursorBase = "withpopup";
  }
  let cursorOverlayBase = cursorBase;
  for (const [rippleIndex, ripple] of ripples.entries()) {
    const inputIndex = cursorInput + 1 + rippleIndex;
    const start = decimal(ripple.tStartMs / 1_000);
    const end = decimal(ripple.tStartMs / 1_000 + 0.5);
    const rippleLabel = `ripple${rippleIndex}`;
    const outputLabel = `withripple${rippleIndex}`;
    filter.push(
      `[${inputIndex}:v]format=rgba,setpts=PTS+${start}/TB[${rippleLabel}]`,
      `[${cursorOverlayBase}][${rippleLabel}]overlay=${decimal(ripple.x)}:${decimal(ripple.y)}:enable='between(t,${start},${end})':eof_action=pass:shortest=0[${outputLabel}]`,
    );
    cursorOverlayBase = outputLabel;
  }

  const cursorOutput = cameraSegments.length > 0 ? "withcursor" : "out";
  filter.push(
    `[${cursorInput}:v]format=rgba[cursor]`,
    `[${cursorOverlayBase}][cursor]overlay=x='${cursorX}':y='${cursorY}':eval=frame:eof_action=repeat:shortest=0[${cursorOutput}]`,
  );
  if (cameraSegments.length > 0) {
    // crop's w/h expressions are evaluated ONCE at filter init (t = NaN), so
    // an animated crop silently renders as identity. zoompan re-evaluates its
    // zoom/x/y per frame; `it` is the input timestamp in seconds. Guard the
    // first frame where `it` can be NaN.
    const zoom = cameraExpression(cameraSegments, "zoom0", "zoom1", "it");
    const focusX = cameraExpression(cameraSegments, "focusX0", "focusX1", "it");
    const focusY = cameraExpression(cameraSegments, "focusY0", "focusY1", "it");
    filter.push(
      `[withcursor]zoompan=z='if(isnan(it),1,max(1,${zoom}))'`
      + `:x='min(max((${focusX})*iw-iw/(2*zoom),0),iw-iw/zoom)'`
      + `:y='min(max((${focusY})*ih-ih/(2*zoom),0),ih-ih/zoom)'`
      + `:d=1:s=${plan.width}x${plan.height}:fps=${decimal(plan.fps)}[out]`,
    );
  }

  if (!(plan.durationMs > 0)) throw new Error("FfmpegPlan.durationMs must be positive");
  return [
    "-y",
    "-loop", "1", "-i", plan.frameChromePath,
    "-f", "concat", "-safe", "0", "-i", plan.stageConcatPath,
    ...(plan.popupConcatPath === undefined
      ? []
      : ["-f", "concat", "-safe", "0", "-i", plan.popupConcatPath]),
    "-loop", "1", "-i", plan.cursorPath,
    ...ripples.flatMap((ripple) => [
      "-stream_loop", "0",
      "-framerate", "24",
      "-start_number", "0",
      "-i", ripple.framesPath,
    ]),
    "-filter_complex", filter.join(";"),
    "-map", "[out]",
    "-an",
    "-r", decimal(plan.fps),
    // Output -t is the termination authority: the looped chrome/cursor inputs
    // never EOF, and overlay eof_action=repeat extends past the main stream's
    // end, so without an explicit duration the encode runs forever.
    "-t", decimal(plan.durationMs / 1_000),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    plan.mp4Path,
  ];
}

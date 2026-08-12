import { describe, expect, it } from "vitest";

import {
  cameraTrack,
  concatFileFor,
  cursorPath,
  ffmpegArgs,
  mapFramesToTicks,
  popupWindow,
  type CompositorEvent,
} from "../src/plan.js";

describe("mapFramesToTicks", () => {
  it("clamps before and after capture and stays monotonic", () => {
    const mapped = mapFramesToTicks([100, 200, 400], 0, 10, 600);
    expect(mapped).toEqual([0, 0, 1, 1, 2, 2]);
    expect(mapped.every((value, index) => index === 0 || value >= mapped[index - 1]!))
      .toBe(true);
  });
});

describe("popupWindow", () => {
  const open: CompositorEvent = {
    verb: "openPopup",
    target: "popup",
    tStartMs: 100,
    tEndMs: 140,
  };

  it("uses the open and close completion timestamps", () => {
    expect(popupWindow([
      open,
      { verb: "closePopup", target: "popup", tStartMs: 700, tEndMs: 710 },
    ])).toEqual({ enterMs: 140, exitMs: 710 });
  });

  it("leaves the popup visible when no close event exists", () => {
    expect(popupWindow([open])).toEqual({ enterMs: 140, exitMs: null });
  });
});

describe("cursorPath", () => {
  it("offsets popup-target coordinates by the popup origin", () => {
    const segments = cursorPath([
      { verb: "click", target: "page", tStartMs: 100, tEndMs: 110, x: 10, y: 20 },
      { verb: "hover", target: "popup", tStartMs: 400, tEndMs: 410, x: 5, y: 7 },
    ], {
      enterMs: 0,
      popupOrigin: { x: 300, y: 116 },
    });

    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ x0: 10, y0: 20 });
    expect(segments.at(-1)).toMatchObject({ x1: 305, y1: 123 });
  });
});

describe("cameraTrack", () => {
  it("eases zoom and popup focus over three segments", () => {
    const segments = cameraTrack([{
      verb: "camera",
      target: "popup",
      tStartMs: 200,
      tEndMs: 800,
      zoom: 1.4,
      focus: "popup",
      ms: 600,
    }], {
      width: 1_000,
      height: 600,
      toolbarH: 100,
      popupOrigin: { x: 676, y: 116 },
      popupSize: { width: 300, height: 400 },
    });

    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ t0: 200, zoom0: 1, focusX0: 0.5 });
    expect(segments.at(-1)).toMatchObject({
      t1: 800,
      zoom1: 1.4,
      focusX1: 0.826,
    });
    expect(segments.at(-1)!.focusY1).toBeCloseTo(316 / 700);
  });

  it("clamps recorded zoom values to schema bounds", () => {
    const segments = cameraTrack([
      { verb: "camera", target: "none", tStartMs: 0, tEndMs: 1, zoom: 9, ms: 1 },
      { verb: "camera", target: "none", tStartMs: 2, tEndMs: 3, zoom: 0.2, ms: 1 },
    ], {
      width: 100,
      height: 100,
      toolbarH: 20,
      popupOrigin: { x: 0, y: 20 },
      popupSize: { width: 50, height: 50 },
    });

    expect(segments[2]!.zoom1).toBe(2.5);
    expect(segments.at(-1)!.zoom1).toBe(1);
  });
});

describe("concatFileFor", () => {
  it("writes consecutive durations whose sum is the capture span plus tail", () => {
    const manifest = concatFileFor([1_000, 1_100, 1_350], "/tmp/frames", 1_000, 150);
    const durations = [...manifest.matchAll(/^duration ([\d.]+)$/gm)]
      .map((match) => Number(match[1]));
    expect(durations.reduce((sum, value) => sum + value, 0)).toBeCloseTo(0.5, 6);
    expect(manifest).toContain("/tmp/frames/00002.jpg");
  });
});

describe("ffmpegArgs", () => {
  it("contains the popup window and piecewise cursor expressions", () => {
    const args = ffmpegArgs({
      frameChromePath: "/tmp/chrome.png",
      stageConcatPath: "/tmp/stage.ffconcat",
      popupConcatPath: "/tmp/popup.ffconcat",
      cursorPath: "/tmp/cursor.png",
      popup: { x: 500, y: 120, enterMs: 200, exitMs: 800 },
      cursorSegments: [
        { t0: 100, t1: 500, x0: 20, y0: 30, x1: 80, y1: 90 },
      ],
      width: 1280,
      height: 900,
      stageY: 100,
      fps: 30,
      durationMs: 1500,
      mp4Path: "/tmp/demo.mp4",
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("enable='between(t,0.2,0.8)'");
    expect(graph).toContain("if(lt(t,");
    // -t must be an OUTPUT option (after -map, before the mp4 path): the looped
    // chrome/cursor inputs never EOF, so -t is what terminates the encode.
    const tIndex = args.lastIndexOf("-t");
    expect(args[tIndex + 1]).toBe("1.5");
    expect(tIndex).toBeGreaterThan(args.indexOf("-map"));
    expect(tIndex).toBeLessThan(args.indexOf("/tmp/demo.mp4"));
  });

  it("omits the popup input and overlay when there is no popup stream", () => {
    const args = ffmpegArgs({
      frameChromePath: "/tmp/chrome.png",
      stageConcatPath: "/tmp/stage.ffconcat",
      cursorPath: "/tmp/cursor.png",
      cursorSegments: [],
      width: 1280,
      height: 900,
      fps: 30,
      durationMs: 1500,
      mp4Path: "/tmp/demo.mp4",
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(args).not.toContain("/tmp/popup.ffconcat");
    expect(graph).not.toContain("[popup]");
    expect(graph).toContain("[framed][cursor]overlay");
    expect(graph).not.toContain("crop=");
  });

  it("adds piecewise camera crop expressions after the cursor", () => {
    const cameraSegments = cameraTrack([{
      verb: "camera",
      target: "page",
      tStartMs: 100,
      tEndMs: 700,
      zoom: 1.4,
      focus: "page",
      ms: 600,
    }], {
      width: 1280,
      height: 800,
      toolbarH: 100,
      popupOrigin: { x: 900, y: 116 },
      popupSize: { width: 300, height: 500 },
    });
    const args = ffmpegArgs({
      frameChromePath: "/tmp/chrome.png",
      stageConcatPath: "/tmp/stage.ffconcat",
      cursorPath: "/tmp/cursor.png",
      cursorSegments: [],
      cameraSegments,
      width: 1280,
      height: 900,
      stageY: 100,
      fps: 30,
      durationMs: 1500,
      mp4Path: "/tmp/demo.mp4",
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[withcursor]crop=");
    expect(graph).toContain("clip(");
    expect(graph).toContain("if(lt(t,");
    expect(graph).toContain("scale=1280:900:flags=lanczos,setsar=1[out]");
  });

  it("adds a finite image-sequence input and timed overlay per ripple", () => {
    const args = ffmpegArgs({
      frameChromePath: "/tmp/chrome.png",
      stageConcatPath: "/tmp/stage.ffconcat",
      cursorPath: "/tmp/cursor.png",
      cursorSegments: [],
      ripples: [{
        framesPath: "/tmp/ripple/%02d.png",
        tStartMs: 250,
        x: 100,
        y: 200,
      }],
      width: 1280,
      height: 900,
      stageY: 100,
      fps: 30,
      durationMs: 1500,
      mp4Path: "/tmp/demo.mp4",
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(args.join(" ")).toContain(
      "-stream_loop 0 -framerate 24 -start_number 0 -i /tmp/ripple/%02d.png",
    );
    expect(graph).toContain("setpts=PTS+0.25/TB[ripple0]");
    expect(graph).toContain("enable='between(t,0.25,0.75)'");
    expect(graph).toContain("overlay=100:200");
  });
});

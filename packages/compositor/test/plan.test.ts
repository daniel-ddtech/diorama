import { describe, expect, it } from "vitest";

import {
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
});

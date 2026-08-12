import { describe, expect, it } from "vitest";

import { parseBeatSheet } from "../src/schema.js";

const baseSheet = `
version: 1
title: defaults
viewport:
  width: 1280
  height: 720
extension:
  path: ./extension
steps:
  - verb: wait
    selector: "#ready"
  - verb: click
    selector: "#ready"
  - verb: type
    selector: "#field"
    text: hi
  - verb: scroll
    deltaY: 120
  - verb: camera
    zoom: 1.25
`;

describe("parseBeatSheet", () => {
  it("parses a valid sheet and applies defaults", () => {
    const sheet = parseBeatSheet(baseSheet);

    expect(sheet.viewport.scale).toBe(2);
    expect(sheet.frame).toEqual({ theme: "dark" });
    expect(sheet.profile).toEqual({});
    expect(sheet.extension.popupPath).toBe("popup.html");
    expect(sheet.extension.popup).toEqual({
      width: 600,
      height: 600,
      autoSize: false,
      position: "right",
    });
    expect(sheet.cursor).toEqual({ scale: 1, ripple: true, shadow: true });
    expect(sheet.output).toEqual({
      fps: 30,
      holdTailMs: 2_000,
      endCard: true,
      formats: [],
    });
    expect(sheet.steps[0]).toMatchObject({
      verb: "wait",
      target: "page",
      timeoutMs: 20_000,
    });
    expect(sheet.steps[1]).toMatchObject({ verb: "click", target: "page" });
    expect(sheet.steps[2]).toMatchObject({
      verb: "type",
      target: "page",
      perCharMs: 40,
    });
    expect(sheet.steps[3]).toMatchObject({
      verb: "scroll",
      target: "page",
      steps: 8,
      stepMs: 40,
    });
    expect(sheet.steps[4]).toMatchObject({
      verb: "camera",
      focus: "none",
      ms: 600,
    });
  });

  it("rejects an invalid verb with its path", () => {
    expect(() => parseBeatSheet(baseSheet.replace("verb: click", "verb: dance")))
      .toThrow(/steps\.1\.verb: Invalid discriminator value/);
  });

  it("rejects goto without a URL with its path", () => {
    expect(() => parseBeatSheet(baseSheet.replace(
      "verb: click\n    selector: \"#ready\"",
      "verb: goto",
    ))).toThrow(/steps\.1\.url: Required/);
  });

  it("rejects waits with more than one condition", () => {
    expect(() => parseBeatSheet(baseSheet.replace(
      "selector: \"#ready\"",
      "selector: \"#ready\"\n    ms: 100",
    ))).toThrow(/wait requires exactly one of selector, ms, or expression/);
  });

  it("enforces camera zoom bounds", () => {
    expect(() => parseBeatSheet(baseSheet.replace("zoom: 1.25", "zoom: 0.99")))
      .toThrow(/steps\.4\.zoom/);
    expect(() => parseBeatSheet(baseSheet.replace("zoom: 1.25", "zoom: 2.51")))
      .toThrow(/steps\.4\.zoom/);

    expect(parseBeatSheet(baseSheet.replace("zoom: 1.25", "zoom: 1")))
      .toBeDefined();
    expect(parseBeatSheet(baseSheet.replace("zoom: 1.25", "zoom: 2.5")))
      .toBeDefined();
  });

  it("validates output formats and applies entry defaults", () => {
    const withFormat = baseSheet.replace("steps:", `output:
  posterAt: intro
  formats:
    - name: square
      width: 1080
      height: 1080
    - name: portrait
      width: 1080
      height: 1920
      crf: 18
      fit: contain
steps:`);
    const sheet = parseBeatSheet(withFormat);
    expect(sheet.output.posterAt).toBe("intro");
    expect(sheet.output.formats).toEqual([{
      name: "square",
      width: 1080,
      height: 1080,
      crf: 28,
      fit: "cover",
    }, {
      name: "portrait",
      width: 1080,
      height: 1920,
      crf: 18,
      fit: "contain",
    }]);
    expect(parseBeatSheet(withFormat.replace("posterAt: intro", "posterAt: 1200"))
      .output.posterAt).toBe(1_200);
    expect(() => parseBeatSheet(withFormat.replace("posterAt: intro", "posterAt: -1")))
      .toThrow(/output\.posterAt/);

    for (const invalidEntry of [
      "width: 0\n      height: 1080",
      "width: 1080\n      height: 0",
      "width: 1080\n      height: 1080\n      crf: 0",
      "width: 1080\n      height: 1080\n      crf: 52",
      "width: 1080\n      height: 1080\n      fit: stretch",
    ]) {
      expect(() => parseBeatSheet(baseSheet.replace("steps:", `output:
  formats:
    - name: invalid
      ${invalidEntry}
steps:`))).toThrow(/output\.formats\.0/);
    }
  });

  it.each([
    ["true", true],
    ["false", false],
    ["{ title: Done, subtitle: Thanks }", { title: "Done", subtitle: "Thanks" }],
  ])("accepts output.endCard %s", (yamlValue, expected) => {
    const sheet = parseBeatSheet(baseSheet.replace("steps:", `output:
  endCard: ${yamlValue}
steps:`));
    expect(sheet.output.endCard).toEqual(expected);
  });
});

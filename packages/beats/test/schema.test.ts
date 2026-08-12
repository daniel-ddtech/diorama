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
    expect(sheet.extension.popupPath).toBe("popup.html");
    expect(sheet.extension.popup).toEqual({ width: 600, height: 600 });
    expect(sheet.output).toEqual({ fps: 30, holdTailMs: 2_000 });
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
});

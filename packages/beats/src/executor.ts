import { writeFileSync } from "node:fs";

import type { Engine, ExtensionTarget, StageTarget } from "@adlicio/diorama-engine";

import {
  type BeatSheet,
  type BeatStep,
  type BeatTarget,
  type CameraFocus,
} from "./schema.js";
import { resolveSelector, type ResolvedSelector } from "./selector.js";

export interface BeatEvent {
  i: number;
  verb: BeatStep["verb"];
  target: BeatTarget | "none";
  tStartMs: number;
  tEndMs: number;
  x?: number;
  y?: number;
  selector?: string;
  name?: string;
  zoom?: number;
  focus?: CameraFocus;
  ms?: number;
  url?: string;
  width?: number;
  height?: number;
  position?: "right" | "left";
}

export interface BeatRunResult {
  events: BeatEvent[];
  stage: StageTarget;
  popup?: StageTarget;
  startedAt: number;
}

export interface RunBeatsOptions {
  log?: (message: string) => void;
  hooks?: {
    onStageReady?(stage: StageTarget): void | Promise<void>;
    onPopupOpened?(popup: StageTarget): void | Promise<void>;
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventTarget(step: BeatStep): BeatTarget | "none" {
  switch (step.verb) {
    case "goto":
      return "page";
    case "wait":
    case "click":
    case "type":
    case "scroll":
    case "hover":
      return step.target;
    case "openPopup":
    case "closePopup":
      return "popup";
    case "camera":
      return step.focus;
    case "hold":
    case "mark":
      return "none";
  }
}

function stageProbeSubstring(sheet: BeatSheet, lastGotoUrl: string): string {
  if (sheet.stageUrlSubstring !== undefined) return sheet.stageUrlSubstring;
  try {
    return new URL(lastGotoUrl).pathname;
  } catch (error) {
    throw new Error(
      `Cannot derive the stage URL pathname from ${JSON.stringify(lastGotoUrl)}`,
      { cause: error },
    );
  }
}

export async function dispatchClick(
  engine: Engine,
  session: string,
  point: ResolvedSelector,
): Promise<void> {
  const position = { x: point.x, y: point.y };
  await engine.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...position,
  }, session);
  await engine.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...position,
  }, session);
  await engine.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...position,
  }, session);
}

export async function requireSelector(
  engine: Engine,
  session: string,
  selector: string,
): Promise<ResolvedSelector> {
  const point = await resolveSelector(engine.cdp, session, selector);
  if (!point.found) throw new Error(`Selector not found: ${JSON.stringify(selector)}`);
  return point;
}

export async function dispatchText(
  engine: Engine,
  session: string,
  text: string,
  perCharMs: number,
): Promise<void> {
  const characters = [...text];
  for (const [characterIndex, character] of characters.entries()) {
    await engine.cdp.send("Input.insertText", { text: character }, session);
    if (characterIndex < characters.length - 1 && perCharMs > 0) {
      await delay(perCharMs);
    }
  }
}

async function waitForSelector(
  engine: Engine,
  session: string,
  selector: string,
  timeoutMs: number,
): Promise<ResolvedSelector> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (true) {
    try {
      const point = await resolveSelector(engine.cdp, session, selector);
      if (point.found) return point;
      lastError = undefined;
    } catch (error) {
      // A navigation can briefly destroy the execution context; keep polling.
      lastError = error;
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) {
      const errorSuffix = lastError instanceof Error ? ` (${lastError.message})` : "";
      throw new Error(
        `wait selector timeout (${timeoutMs}ms): ${JSON.stringify(selector)}${errorSuffix}`,
      );
    }
    await delay(Math.min(100, timeoutMs - elapsed));
  }
}

export async function runBeats(
  engine: Engine,
  ext: ExtensionTarget,
  sheet: BeatSheet,
  opts: RunBeatsOptions = {},
): Promise<BeatRunResult> {
  const startedAt = Date.now();
  const events: BeatEvent[] = [];
  let stage: StageTarget | undefined;
  let popup: StageTarget | undefined;
  let lastGotoUrl: string | undefined;

  const requireStage = (): StageTarget => {
    if (!stage) throw new Error("A goto step must create the stage before page actions");
    return stage;
  };
  const requirePopup = (): StageTarget => {
    if (!popup) throw new Error("No popup is open");
    return popup;
  };
  const sessionFor = (target: BeatTarget): string => (
    target === "page" ? requireStage().session : requirePopup().session
  );

  for (const [i, step] of sheet.steps.entries()) {
    const tStartMs = Date.now() - startedAt;
    const details: Partial<BeatEvent> = {};

    switch (step.verb) {
      case "goto": {
        if (!stage) {
          stage = await engine.createStage(step.url, {
            width: sheet.viewport.width,
            height: sheet.viewport.height,
            deviceScaleFactor: sheet.viewport.scale,
          });
          await opts.hooks?.onStageReady?.(stage);
        } else {
          await engine.cdp.send("Page.navigate", { url: step.url }, stage.session);
        }
        lastGotoUrl = step.url;
        details.url = step.url;
        break;
      }

      case "wait": {
        if (step.selector !== undefined) {
          const point = await waitForSelector(
            engine,
            sessionFor(step.target),
            step.selector,
            step.timeoutMs,
          );
          details.selector = step.selector;
          details.x = point.x;
          details.y = point.y;
        } else if (step.ms !== undefined) {
          await delay(step.ms);
        } else if (step.expression !== undefined) {
          await engine.cdp.waitForExpression(
            sessionFor(step.target),
            step.expression,
            { timeoutMs: step.timeoutMs },
          );
        }
        break;
      }

      case "click": {
        const session = sessionFor(step.target);
        const point = await requireSelector(engine, session, step.selector);
        await dispatchClick(engine, session, point);
        details.selector = step.selector;
        details.x = point.x;
        details.y = point.y;
        break;
      }

      case "type": {
        const session = sessionFor(step.target);
        const point = await requireSelector(engine, session, step.selector);
        await dispatchClick(engine, session, point);
        await dispatchText(engine, session, step.text, step.perCharMs);
        details.selector = step.selector;
        details.x = point.x;
        details.y = point.y;
        break;
      }

      case "scroll": {
        const session = sessionFor(step.target);
        const dimensions = step.target === "page"
          ? sheet.viewport
          : sheet.extension.popup;
        const x = dimensions.width / 2;
        const y = dimensions.height / 2;
        for (let scrollIndex = 0; scrollIndex < step.steps; scrollIndex += 1) {
          await engine.cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x,
            y,
            deltaX: 0,
            deltaY: step.deltaY / step.steps,
          }, session);
          if (scrollIndex < step.steps - 1 && step.stepMs > 0) {
            await delay(step.stepMs);
          }
        }
        details.x = x;
        details.y = y;
        break;
      }

      case "hover": {
        const session = sessionFor(step.target);
        const point = await requireSelector(engine, session, step.selector);
        await engine.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: point.x,
          y: point.y,
        }, session);
        details.selector = step.selector;
        details.x = point.x;
        details.y = point.y;
        break;
      }

      case "openPopup": {
        if (popup) throw new Error("A popup is already open");
        requireStage();
        if (!lastGotoUrl) throw new Error("A goto step must run before openPopup");
        const shimTabId = await engine.resolveStageTabId(
          ext.swSession,
          stageProbeSubstring(sheet, lastGotoUrl),
        );
        const configuredPopup = sheet.extension.popup;
        const initialWidth = configuredPopup.autoSize ? 25 : configuredPopup.width;
        const initialHeight = configuredPopup.autoSize ? 25 : configuredPopup.height;
        popup = await engine.openExtensionPage(
          ext.extensionId,
          sheet.extension.popupPath,
          {
            shimTabId,
            width: initialWidth,
            height: initialHeight,
            deviceScaleFactor: sheet.viewport.scale,
          },
        );
        let finalWidth = configuredPopup.width;
        let finalHeight = configuredPopup.height;
        if (configuredPopup.autoSize) {
          try {
            await engine.cdp.waitForExpression(
              popup.session,
              "document.body?.innerText.length > 0",
              { timeoutMs: 300, pollMs: 25, label: "popup body content" },
            );
          } catch {
            // A popup with no body text still gets measured after the settle window.
          }
          const measured = await engine.measureContentSize(popup.session);
          finalWidth = Math.min(800, Math.max(25, measured.width));
          finalHeight = Math.min(600, Math.max(25, measured.height));
          await engine.applyViewport(popup.session, {
            width: finalWidth,
            height: finalHeight,
            deviceScaleFactor: sheet.viewport.scale,
          });
        }
        details.width = finalWidth;
        details.height = finalHeight;
        details.position = configuredPopup.position;
        await opts.hooks?.onPopupOpened?.(popup);
        break;
      }

      case "closePopup": {
        const currentPopup = requirePopup();
        await engine.cdp.send("Target.closeTarget", { targetId: currentPopup.targetId });
        popup = undefined;
        break;
      }

      case "camera":
        details.zoom = step.zoom;
        details.focus = step.focus;
        details.ms = step.ms;
        await delay(step.ms);
        break;

      case "hold":
        await delay(step.ms);
        break;

      case "mark":
        details.name = step.name;
        break;
    }

    const event: BeatEvent = {
      i,
      verb: step.verb,
      target: eventTarget(step),
      tStartMs,
      tEndMs: Date.now() - startedAt,
      ...details,
    };
    events.push(event);
    opts.log?.(`${i} ${step.verb} ${event.tStartMs}-${event.tEndMs}ms`);
  }

  const completedStage = requireStage();
  await delay(sheet.output.holdTailMs);
  return {
    events,
    stage: completedStage,
    ...(popup ? { popup } : {}),
    startedAt,
  };
}

export function writeEventLog(
  result: BeatRunResult,
  filePath: string,
): void {
  writeFileSync(filePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

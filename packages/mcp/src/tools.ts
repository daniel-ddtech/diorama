import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  dispatchClick,
  dispatchText,
  loadBeatSheet,
  parseBeatSheet,
  requireSelector,
} from "@diorama/beats";
import {
  Engine,
  type StageTarget,
  type ViewportOptions,
} from "@diorama/engine";
import { recordDemo, runDoctorChecks } from "diorama";

import type { ToolDefinition, ToolRegistry } from "./server.js";

interface SessionState {
  engine: Engine;
  extensionId: string;
  swSession: string;
  stage: StageTarget;
  stageTabId: number;
  popup?: StageTarget;
  popupPath?: string;
  viewport: ViewportOptions;
  profileDir: string;
}

interface ExtensionManifest {
  name: string;
  popupPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalPositiveInteger(
  args: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value as number;
}

function positiveNumber(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  integer: boolean,
): number {
  const value = args[name] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseViewport(value: unknown): ViewportOptions {
  if (value !== undefined && !isRecord(value)) {
    throw new Error("viewport must be an object");
  }
  const viewport = value ?? {};
  return {
    width: positiveNumber(viewport, "width", 1280, true),
    height: positiveNumber(viewport, "height", 800, true),
    deviceScaleFactor: positiveNumber(viewport, "deviceScaleFactor", 1, false),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loadExtensionManifest(extensionPath: string): Promise<ExtensionManifest> {
  const manifestPath = join(extensionPath, "manifest.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read extension manifest at ${manifestPath}`, { cause: error });
  }
  if (!isRecord(parsed) || typeof parsed.name !== "string" || parsed.name.trim() === "") {
    throw new Error(`Extension manifest at ${manifestPath} has no display name`);
  }
  const action = isRecord(parsed.action) ? parsed.action : undefined;
  const popupPath = typeof action?.default_popup === "string" && action.default_popup !== ""
    ? action.default_popup
    : undefined;
  return { name: parsed.name, ...(popupPath ? { popupPath } : {}) };
}

function tool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: ToolDefinition["handler"],
): ToolDefinition {
  return { name, description, inputSchema, handler };
}

const targetSchema = { type: "string", enum: ["page", "popup"] };
const sessionIdSchema = { type: "string", minLength: 1 };

export function createToolRegistry(): ToolRegistry {
  const sessions = new Map<string, SessionState>();

  const requireSession = (sessionId: string): SessionState => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown sessionId: ${sessionId}`);
    return session;
  };

  const sessionForTarget = (
    session: SessionState,
    target: unknown,
  ): string => {
    if (target === "page") return session.stage.session;
    if (target === "popup") {
      if (!session.popup) throw new Error("No popup is open");
      return session.popup.session;
    }
    throw new Error('target must be "page" or "popup"');
  };

  return {
    record_demo: tool(
      "record_demo",
      "Record and render a Diorama beat sheet.",
      {
        type: "object",
        properties: {
          sheetPath: { type: "string", minLength: 1 },
          outDir: { type: "string", minLength: 1 },
          fps: { type: "integer", minimum: 1 },
        },
        required: ["sheetPath"],
        additionalProperties: false,
      },
      async (args) => {
        const sheetPath = requiredString(args, "sheetPath");
        const outDir = optionalString(args, "outDir");
        const fps = optionalPositiveInteger(args, "fps");
        const result = await recordDemo({
          sheetPath,
          ...(outDir === undefined ? {} : { outDir }),
          ...(fps === undefined ? {} : { fps }),
        });
        return {
          mp4Path: result.mp4Path,
          posterPath: result.posterPath,
          durationMs: result.durationMs,
          skipped: result.skipped,
        };
      },
    ),

    validate_sheet: tool(
      "validate_sheet",
      "Validate a Diorama beat sheet from a path or inline YAML.",
      {
        type: "object",
        properties: {
          sheetPath: { type: "string", minLength: 1 },
          yaml: { type: "string", minLength: 1 },
        },
        oneOf: [
          { required: ["sheetPath"] },
          { required: ["yaml"] },
        ],
        additionalProperties: false,
      },
      async (args) => {
        const sheetPath = optionalString(args, "sheetPath");
        const yaml = optionalString(args, "yaml");
        if ((sheetPath === undefined) === (yaml === undefined)) {
          throw new Error("Provide exactly one of sheetPath or yaml");
        }
        const sheet = sheetPath === undefined
          ? parseBeatSheet(yaml!)
          : loadBeatSheet(resolve(sheetPath));
        return { ok: true, title: sheet.title, stepCount: sheet.steps.length };
      },
    ),

    doctor: tool(
      "doctor",
      "Run Diorama's Chrome, ffmpeg, ffprobe, and Node checks.",
      { type: "object", properties: {}, additionalProperties: false },
      async () => ({ checks: runDoctorChecks() }),
    ),

    launch_session: tool(
      "launch_session",
      "Launch Chrome with an extension and create a stage tab.",
      {
        type: "object",
        properties: {
          extensionPath: { type: "string", minLength: 1 },
          url: { type: "string", format: "uri" },
          viewport: {
            type: "object",
            properties: {
              width: { type: "integer", minimum: 1 },
              height: { type: "integer", minimum: 1 },
              deviceScaleFactor: { type: "number", exclusiveMinimum: 0 },
            },
            additionalProperties: false,
          },
        },
        required: ["extensionPath", "url"],
        additionalProperties: false,
      },
      async (args) => {
        const extensionPath = resolve(requiredString(args, "extensionPath"));
        const url = requiredString(args, "url");
        const viewport = parseViewport(args.viewport);
        const manifest = await loadExtensionManifest(extensionPath);
        const profileDir = await mkdtemp(join(tmpdir(), "diorama-mcp-profile-"));
        let engine: Engine | undefined;
        try {
          engine = await Engine.launch({ extensionDir: extensionPath, userDataDir: profileDir });
          const extension = await engine.findExtension(
            new RegExp(escapeRegExp(manifest.name), "i"),
          );
          const stage = await engine.createStage(url, viewport);
          const stageTabId = await engine.resolveStageTabId(extension.swSession, url);
          const sessionId = randomUUID();
          sessions.set(sessionId, {
            engine,
            extensionId: extension.extensionId,
            swSession: extension.swSession,
            stage,
            stageTabId,
            ...(manifest.popupPath ? { popupPath: manifest.popupPath } : {}),
            viewport,
            profileDir,
          });
          return {
            sessionId,
            extensionId: extension.extensionId,
            stageTabId,
          };
        } catch (error) {
          try {
            if (engine) await engine.close();
          } finally {
            await rm(profileDir, { recursive: true, force: true });
          }
          throw error;
        }
      },
    ),

    open_popup: tool(
      "open_popup",
      "Open the extension popup with active-tab queries shimmed to the stage.",
      {
        type: "object",
        properties: { sessionId: sessionIdSchema },
        required: ["sessionId"],
        additionalProperties: false,
      },
      async (args) => {
        const session = requireSession(requiredString(args, "sessionId"));
        if (session.popup) throw new Error("A popup is already open");
        if (!session.popupPath) throw new Error("The extension manifest has no default popup");
        session.popup = await session.engine.openExtensionPage(
          session.extensionId,
          session.popupPath,
          {
            shimTabId: session.stageTabId,
            width: 600,
            height: 600,
            deviceScaleFactor: session.viewport.deviceScaleFactor,
          },
        );
        return { ok: true };
      },
    ),

    click: tool(
      "click",
      "Click a selector in the stage page or popup.",
      {
        type: "object",
        properties: {
          sessionId: sessionIdSchema,
          target: targetSchema,
          selector: { type: "string", minLength: 1 },
        },
        required: ["sessionId", "target", "selector"],
        additionalProperties: false,
      },
      async (args) => {
        const session = requireSession(requiredString(args, "sessionId"));
        const targetSession = sessionForTarget(session, args.target);
        const point = await requireSelector(
          session.engine,
          targetSession,
          requiredString(args, "selector"),
        );
        await dispatchClick(session.engine, targetSession, point);
        return { ok: true };
      },
    ),

    type_text: tool(
      "type_text",
      "Focus a selector and type text in the stage page or popup.",
      {
        type: "object",
        properties: {
          sessionId: sessionIdSchema,
          target: targetSchema,
          selector: { type: "string", minLength: 1 },
          text: { type: "string" },
        },
        required: ["sessionId", "target", "selector", "text"],
        additionalProperties: false,
      },
      async (args) => {
        const session = requireSession(requiredString(args, "sessionId"));
        const targetSession = sessionForTarget(session, args.target);
        const selector = requiredString(args, "selector");
        if (typeof args.text !== "string") throw new Error("text must be a string");
        const point = await requireSelector(session.engine, targetSession, selector);
        await dispatchClick(session.engine, targetSession, point);
        await dispatchText(session.engine, targetSession, args.text, 0);
        return { ok: true };
      },
    ),

    navigate: tool(
      "navigate",
      "Navigate the stage page to a URL.",
      {
        type: "object",
        properties: {
          sessionId: sessionIdSchema,
          url: { type: "string", format: "uri" },
        },
        required: ["sessionId", "url"],
        additionalProperties: false,
      },
      async (args) => {
        const session = requireSession(requiredString(args, "sessionId"));
        await session.engine.cdp.send(
          "Page.navigate",
          { url: requiredString(args, "url") },
          session.stage.session,
        );
        return { ok: true };
      },
    ),

    screenshot: tool(
      "screenshot",
      "Capture a PNG to a temporary file without inlining its image data.",
      {
        type: "object",
        properties: {
          sessionId: sessionIdSchema,
          target: targetSchema,
        },
        required: ["sessionId", "target"],
        additionalProperties: false,
      },
      async (args) => {
        const session = requireSession(requiredString(args, "sessionId"));
        const targetSession = sessionForTarget(session, args.target);
        const image = await session.engine.screenshot(targetSession, { format: "png" });
        const screenshotDir = await mkdtemp(join(tmpdir(), "diorama-mcp-screenshot-"));
        const path = join(screenshotDir, `${String(args.target)}.png`);
        await writeFile(path, image);
        return { path, base64Length: image.toString("base64").length };
      },
    ),

    close_session: tool(
      "close_session",
      "Close a Diorama browser session and remove its temporary profile.",
      {
        type: "object",
        properties: { sessionId: sessionIdSchema },
        required: ["sessionId"],
        additionalProperties: false,
      },
      async (args) => {
        const sessionId = requiredString(args, "sessionId");
        const session = requireSession(sessionId);
        sessions.delete(sessionId);
        try {
          await session.engine.close();
        } finally {
          await rm(session.profileDir, { recursive: true, force: true });
        }
        return { ok: true };
      },
    ),
  };
}

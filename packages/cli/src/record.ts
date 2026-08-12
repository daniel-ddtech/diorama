import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadBeatSheet, runBeats, writeEventLog } from "@adlicio/diorama-beats";
import {
  renderDemo,
  type RenderDemoResult,
} from "@adlicio/diorama-compositor";
import { Engine, type CaptureLoop } from "@adlicio/diorama-engine";

export interface RecordCommandOptions {
  log?: (message: string) => void;
}

export interface RecordDemoOptions {
  sheetPath: string;
  outDir?: string;
  /** Exact main output path. Primarily used by embedded callers. */
  outPath?: string;
  /** Exact poster output path. Primarily used by embedded callers. */
  posterPath?: string;
  fps?: number;
  keepRun?: boolean;
  /** Override the sheet's output.endCard (e.g. --no-end-card). */
  endCard?: boolean;
  /** Override the sheet's persistent Chrome profile directory. */
  profileDir?: string;
  /** Override the sheet's extension storage seed JSON file. */
  seedStorage?: string;
  /** Receive orchestration and per-step progress. */
  log?: (message: string) => void;
}

export interface RecordDemoResult extends RenderDemoResult {
  skipped: Record<string, number>;
  runDir?: string;
}

export type RecordCommandResult = RecordDemoResult;

interface ExtensionManifest {
  name: string;
  icons: Record<string, string>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleSlug(title: string): string {
  return title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "demo";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadSeedStorage(filePath: string): Promise<object> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read seed storage file at ${filePath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Invalid seed storage JSON at ${filePath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Seed storage JSON at ${filePath} must be a JSON object`);
  }
  return parsed;
}

async function loadExtensionManifest(
  extensionDir: string,
): Promise<{ manifest: ExtensionManifest; iconPath: string }> {
  const manifestPath = join(extensionDir, "manifest.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read extension manifest at ${manifestPath}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Extension manifest at ${manifestPath} must be a JSON object`);
  }
  const manifest = parsed as Record<string, unknown>;
  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    throw new Error(`Extension manifest at ${manifestPath} has no display name`);
  }
  if (typeof manifest.icons !== "object" || manifest.icons === null) {
    throw new Error(`Extension manifest at ${manifestPath} has no icons`);
  }
  const icons = Object.entries(manifest.icons as Record<string, unknown>)
    .filter((entry): entry is [string, string] => (
      Number.isFinite(Number(entry[0])) && typeof entry[1] === "string"
    ))
    .sort((left, right) => Number(right[0]) - Number(left[0]));
  const largestIcon = icons[0]?.[1];
  if (!largestIcon) {
    throw new Error(`Extension manifest at ${manifestPath} has no icons`);
  }
  const iconPath = resolve(extensionDir, largestIcon.replace(/^[/\\]+/, ""));
  if (!existsSync(iconPath)) {
    throw new Error(`Extension icon not found at ${iconPath}`);
  }

  return {
    manifest: {
      name: manifest.name,
      icons: Object.fromEntries(icons),
    },
    iconPath,
  };
}

export async function recordDemo(
  options: RecordDemoOptions,
): Promise<RecordDemoResult> {
  const log = options.log ?? (() => {});
  const sheetPath = resolve(options.sheetPath);
  if (!existsSync(sheetPath)) {
    throw new Error(`Beat sheet not found: ${sheetPath}`);
  }
  const fps = options.fps ?? 30;
  if (!Number.isInteger(fps) || fps <= 0) {
    throw new Error("fps must be a positive integer");
  }

  const sheet = loadBeatSheet(sheetPath);
  const sheetDir = dirname(sheetPath);
  const extensionDir = sheet.extension === undefined
    ? undefined
    : resolve(sheetDir, sheet.extension.path);
  const extensionAssets = extensionDir === undefined
    ? undefined
    : await loadExtensionManifest(extensionDir);
  const configuredSeedStorage = options.seedStorage ?? sheet.profile.seedStorage;
  if (configuredSeedStorage !== undefined && extensionDir === undefined) {
    throw new Error("seedStorage requires an extension block");
  }
  const seedStorage = configuredSeedStorage === undefined
    ? undefined
    : await loadSeedStorage(resolve(sheetDir, configuredSeedStorage));
  const outputDir = resolve(options.outDir ?? "diorama-out");
  const slug = titleSlug(sheet.title);
  const outPath = resolve(options.outPath ?? join(outputDir, `${slug}.mp4`));
  const posterPath = resolve(
    options.posterPath ?? join(outputDir, `${slug}-poster.jpg`),
  );
  const configuredProfileDir = options.profileDir ?? sheet.profile.dir;
  const temporaryProfile = configuredProfileDir === undefined;
  const profileDir = temporaryProfile
    ? await mkdtemp(join(tmpdir(), "diorama-profile-"))
    : resolve(sheetDir, configuredProfileDir);
  if (!temporaryProfile) await mkdir(profileDir, { recursive: true });
  let runDir: string;
  try {
    runDir = await mkdtemp(join(tmpdir(), "diorama-run-"));
  } catch (error) {
    if (temporaryProfile) await rm(profileDir, { recursive: true, force: true });
    throw error;
  }
  const keepRun = options.keepRun ?? false;

  let engine: Engine | undefined;
  let loop: CaptureLoop | undefined;
  let loopStopped = false;
  let rendered: RenderDemoResult | undefined;
  let skipped: Record<string, number> = {};
  try {
    log("Launching Chrome");
    engine = await Engine.launch({
      userDataDir: profileDir,
      ...(extensionDir === undefined ? {} : { extensionDir }),
    });
    const extension = extensionAssets === undefined
      ? undefined
      : await engine.findExtension(
        new RegExp(escapeRegExp(extensionAssets.manifest.name), "i"),
      );
    if (seedStorage !== undefined) {
      if (!extension) throw new Error("seedStorage requires an extension block");
      log("Seeding extension storage");
      await engine.seedStorage(extension.swSession, seedStorage);
    }
    log("Running beats");
    const result = await runBeats(engine, extension, sheet, {
      log,
      hooks: {
        onStageReady: (stage) => {
          loop = engine!.startCaptureLoop(
            [{ name: "stage", session: stage.session }],
            { outDir: runDir, intervalMs: 80 },
          );
        },
        onPopupOpened: (popup) => {
          if (!loop) throw new Error("Capture loop was not started before the popup opened");
          loop.add("popup", popup.session);
        },
      },
    });
    if (!loop) throw new Error("The beat sheet did not create a stage to capture");
    const capture = await loop.stop();
    loopStopped = true;
    skipped = capture.skipped ?? {};
    writeEventLog(result, join(runDir, "events.json"));
    const configuredEndCard = options.endCard ?? sheet.output.endCard;
    const themePath = sheet.frame.theme === "dark" || sheet.frame.theme === "light"
      ? undefined
      : resolve(sheetDir, sheet.frame.theme);
    log("Rendering video");
    rendered = await renderDemo({
      runDir,
      sheet: {
        title: sheet.title,
        frame: {
          ...sheet.frame,
          ...(themePath === undefined ? {} : { themePath }),
        },
        cursor: sheet.cursor,
        viewport: sheet.viewport,
        ...(sheet.extension === undefined
          ? {}
          : { extension: { popup: sheet.extension.popup } }),
        output: {
          posterAt: sheet.output.posterAt,
          formats: sheet.output.formats,
        },
      },
      ...(extensionAssets === undefined ? {} : { iconPath: extensionAssets.iconPath }),
      outPath,
      posterPath,
      fps,
      endCard: configuredEndCard,
      log,
    });
    log("Recording complete");
  } finally {
    if (loop && !loopStopped) {
      try {
        await loop.stop();
      } catch {
        // Preserve the command failure; the engine is still closed below.
      }
    }
    try {
      if (engine) await engine.close();
    } finally {
      await Promise.all([
        ...(temporaryProfile
          ? [rm(profileDir, { recursive: true, force: true })]
          : []),
        ...(!keepRun ? [rm(runDir, { recursive: true, force: true })] : []),
      ]);
    }
  }

  if (!rendered) throw new Error("Recording did not produce output");
  return {
    ...rendered,
    skipped,
    ...(keepRun ? { runDir } : {}),
  };
}

export function parseRecordCommandArgs(args: string[]): RecordDemoOptions {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      out: { type: "string" },
      fps: { type: "string" },
      "keep-run": { type: "boolean", default: false },
      "no-end-card": { type: "boolean", default: false },
      "profile-dir": { type: "string" },
      "seed-storage": { type: "string" },
    },
  });
  if (positionals.length !== 1) {
    throw new Error("record requires exactly one beat sheet path");
  }
  const fps = values.fps === undefined ? 30 : Number(values.fps);
  if (!Number.isInteger(fps) || fps <= 0) {
    throw new Error("--fps must be a positive integer");
  }

  return {
    sheetPath: positionals[0]!,
    ...(values.out === undefined ? {} : { outDir: values.out }),
    fps,
    keepRun: values["keep-run"],
    ...(values["no-end-card"] ? { endCard: false } : {}),
    ...(values["profile-dir"] === undefined
      ? {}
      : { profileDir: values["profile-dir"] }),
    ...(values["seed-storage"] === undefined
      ? {}
      : { seedStorage: values["seed-storage"] }),
  };
}

export async function recordCommand(
  args: string[],
  options: RecordCommandOptions = {},
): Promise<RecordCommandResult> {
  const rendered = await recordDemo(parseRecordCommandArgs(args));
  const log = options.log ?? console.log;
  log(`mp4: ${rendered.mp4Path}`);
  log(`poster: ${rendered.posterPath}`);
  for (const format of rendered.formats) {
    log(`format ${format.name}: ${format.path}`);
  }
  log(`duration: ${(rendered.durationMs / 1_000).toFixed(2)}s`);
  return {
    ...rendered,
  };
}

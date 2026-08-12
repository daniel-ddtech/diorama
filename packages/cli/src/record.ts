import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadBeatSheet, runBeats, writeEventLog } from "@diorama/beats";
import {
  renderDemo,
  type RenderDemoResult,
} from "@diorama/compositor";
import { Engine, type CaptureLoop } from "@diorama/engine";

export interface RecordCommandOptions {
  log?: (message: string) => void;
}

export interface RecordCommandResult extends RenderDemoResult {
  runDir?: string;
}

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

export async function recordCommand(
  args: string[],
  options: RecordCommandOptions = {},
): Promise<RecordCommandResult> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      out: { type: "string" },
      fps: { type: "string" },
      "keep-run": { type: "boolean", default: false },
    },
  });
  if (positionals.length !== 1) {
    throw new Error("record requires exactly one beat sheet path");
  }
  const sheetPath = resolve(positionals[0]!);
  if (!existsSync(sheetPath)) {
    throw new Error(`Beat sheet not found: ${sheetPath}`);
  }
  const fps = values.fps === undefined ? 30 : Number(values.fps);
  if (!Number.isInteger(fps) || fps <= 0) {
    throw new Error("--fps must be a positive integer");
  }

  const sheet = loadBeatSheet(sheetPath);
  const extensionDir = resolve(dirname(sheetPath), sheet.extension.path);
  const { manifest, iconPath } = await loadExtensionManifest(extensionDir);
  const outputDir = resolve(values.out ?? "diorama-out");
  const slug = titleSlug(sheet.title);
  const outPath = join(outputDir, `${slug}.mp4`);
  const posterPath = join(outputDir, `${slug}-poster.jpg`);
  const profileDir = await mkdtemp(join(tmpdir(), "diorama-profile-"));
  let runDir: string;
  try {
    runDir = await mkdtemp(join(tmpdir(), "diorama-run-"));
  } catch (error) {
    await rm(profileDir, { recursive: true, force: true });
    throw error;
  }
  const keepRun = values["keep-run"];

  let engine: Engine | undefined;
  let loop: CaptureLoop | undefined;
  let loopStopped = false;
  let rendered: RenderDemoResult | undefined;
  try {
    engine = await Engine.launch({ extensionDir, userDataDir: profileDir });
    const extension = await engine.findExtension(
      new RegExp(escapeRegExp(manifest.name), "i"),
    );
    const result = await runBeats(engine, extension, sheet, {
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
    await loop.stop();
    loopStopped = true;
    writeEventLog(result, join(runDir, "events.json"));
    rendered = await renderDemo({
      runDir,
      sheet: {
        title: sheet.title,
        viewport: sheet.viewport,
        extension: { popup: sheet.extension.popup },
      },
      iconPath,
      outPath,
      posterPath,
      fps,
    });
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
        rm(profileDir, { recursive: true, force: true }),
        ...(!keepRun ? [rm(runDir, { recursive: true, force: true })] : []),
      ]);
    }
  }

  if (!rendered) throw new Error("Recording did not produce output");
  const log = options.log ?? console.log;
  log(`mp4: ${rendered.mp4Path}`);
  log(`poster: ${rendered.posterPath}`);
  log(`duration: ${(rendered.durationMs / 1_000).toFixed(2)}s`);
  return {
    ...rendered,
    ...(keepRun ? { runDir } : {}),
  };
}

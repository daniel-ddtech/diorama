import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export interface InitCommandOptions {
  log?: (message: string) => void;
}

export interface InitCommandResult {
  sheetPath: string;
}

export const STARTER_BEAT_SHEET = `# Diorama beat sheet
# Edit the title, extension path, stage URL, and steps for your demo.
version: 1
title: My extension demo
viewport:
  width: 1280
  height: 800
  scale: 2
extension:
  path: "./"
  popup:
    width: 600
    height: 600
steps:
  - verb: goto
    url: https://example.com
  - verb: wait
    selector: body
  - verb: openPopup
  - verb: hold
    ms: 1500
  - verb: mark
    name: end
`;

export function initCommand(
  args: string[],
  options: InitCommandOptions = {},
): InitCommandResult {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      force: { type: "boolean", default: false },
    },
  });
  if (positionals.length > 1) {
    throw new Error("init accepts at most one directory");
  }

  const targetDir = resolve(positionals[0] ?? ".");
  const sheetPath = join(targetDir, "demo.beats.yaml");
  if (existsSync(sheetPath) && !values.force) {
    throw new Error(`Refusing to overwrite ${sheetPath}; pass --force to replace it`);
  }

  mkdirSync(targetDir, { recursive: true });
  writeFileSync(sheetPath, STARTER_BEAT_SHEET, "utf8");
  const log = options.log ?? console.log;
  log(`wrote ${sheetPath}`);
  log("next: diorama record demo.beats.yaml");
  return { sheetPath };
}

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

import { resolveChromeBinary } from "@diorama/engine";

export interface DoctorCheck {
  name: "chrome" | "ffmpeg" | "ffprobe" | "node";
  ok: boolean;
  hint: string;
}

export interface DoctorDependencies {
  exists?: (path: string) => boolean;
  spawn?: (command: string, args: string[]) => {
    status: number | null;
    error?: Error;
  };
  nodeVersion?: string;
}

export interface DoctorCommandOptions extends DoctorDependencies {
  log?: (message: string) => void;
}

function binaryWorks(
  binary: string,
  spawn: NonNullable<DoctorDependencies["spawn"]>,
): boolean {
  try {
    return spawn(binary, ["-version"]).status === 0;
  } catch {
    return false;
  }
}

export function runDoctorChecks(
  dependencies: DoctorDependencies = {},
): DoctorCheck[] {
  const fileExists = dependencies.exists ?? existsSync;
  const spawn = dependencies.spawn ?? ((command, args) => (
    spawnSync(command, args, { stdio: "ignore" })
  ));
  const chrome = resolveChromeBinary();
  const ffmpeg = process.env.DIORAMA_FFMPEG ?? "ffmpeg";
  const ffprobe = process.env.DIORAMA_FFPROBE ?? "ffprobe";
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
  const nodeMajor = Number(nodeVersion.split(".", 1)[0]);

  return [
    {
      name: "chrome",
      ok: fileExists(chrome),
      hint: `set DIORAMA_CHROME to a Chrome for Testing binary (checked ${chrome})`,
    },
    {
      name: "ffmpeg",
      ok: binaryWorks(ffmpeg, spawn),
      hint: "install ffmpeg or set DIORAMA_FFMPEG",
    },
    {
      name: "ffprobe",
      ok: binaryWorks(ffprobe, spawn),
      hint: "install ffprobe or set DIORAMA_FFPROBE",
    },
    {
      name: "node",
      ok: Number.isInteger(nodeMajor) && nodeMajor >= 22,
      hint: `install Node 22 or newer (found ${nodeVersion})`,
    },
  ];
}

export function doctorCommand(
  args: string[],
  options: DoctorCommandOptions = {},
): number {
  parseArgs({ args, strict: true, options: {} });
  const checks = runDoctorChecks(options);
  const log = options.log ?? console.log;
  for (const check of checks) {
    log(check.ok
      ? `ok ${check.name}`
      : `MISSING ${check.name} ${check.hint}`);
  }
  return checks.some((check) => (
    (check.name === "chrome" || check.name === "ffmpeg") && !check.ok
  )) ? 1 : 0;
}

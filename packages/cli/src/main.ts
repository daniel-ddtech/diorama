#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { doctorCommand } from "./doctor.js";
import { initCommand } from "./init.js";
import { recordCommand } from "./record.js";

const HELP = `Usage: diorama <command> [options]

Commands:
  init [dir]                         Write a starter demo.beats.yaml
  record <sheet.yaml> [options]      Record and render a demo
  doctor                             Check Chrome, ffmpeg, ffprobe, and Node
  mcp                                Show how to start the standalone MCP server

Record options:
  --out <dir>                        Output directory (default: ./diorama-out)
  --fps <n>                          Output frame rate (default: 30)
  --keep-run                         Keep captured frames and event files
`;

export interface MainIo {
  log(message: string): void;
  error(message: string): void;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const oneLine = message.replace(/\s+/g, " ").trim();
  if (!(error instanceof Error) || error.cause === undefined) {
    return `error: ${oneLine}`;
  }
  const cause = error.cause instanceof Error
    ? error.cause.message
    : String(error.cause);
  return `error: ${oneLine} (cause: ${cause.replace(/\s+/g, " ").trim()})`;
}

export async function main(
  args: string[] = process.argv.slice(2),
  io: MainIo = { log: console.log, error: console.error },
): Promise<number> {
  const [command, ...commandArgs] = args;
  if (command === undefined || command === "--help") {
    io.log(HELP);
    return 0;
  }

  try {
    switch (command) {
      case "init":
        initCommand(commandArgs, { log: io.log });
        return 0;
      case "record":
        await recordCommand(commandArgs, { log: io.log });
        return 0;
      case "doctor":
        return doctorCommand(commandArgs, { log: io.log });
      case "mcp":
        if (commandArgs.length > 0) throw new Error("mcp does not accept arguments");
        io.log("Run the Diorama MCP stdio server with: diorama-mcp");
        return 0;
      default:
        io.log(HELP);
        return 2;
    }
  } catch (error) {
    io.error(errorMessage(error));
    return 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath
  && realpathSync(resolve(invokedPath)) === realpathSync(fileURLToPath(import.meta.url))
) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

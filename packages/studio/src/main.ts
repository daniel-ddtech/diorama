#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createStudioServer } from "./server.js";

export interface StudioMainIo {
  log(message: string): void;
}

export async function main(
  args: string[] = process.argv.slice(2),
  io: StudioMainIo = { log: console.log },
): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      port: { type: "string" },
    },
  });
  const port = values.port === undefined ? 4517 : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }

  const server = createStudioServer({ port });
  await once(server, "listening");
  const url = `http://localhost:${port}`;
  io.log(`diorama studio → ${url}`);

  if (process.platform === "darwin") {
    try {
      const opener = spawn("open", [url], {
        detached: true,
        stdio: "ignore",
      });
      opener.once("error", () => {});
      opener.unref();
    } catch {
      // Opening the browser is a convenience; the server remains usable.
    }
  }
  return 0;
}

const invokedPath = process.argv[1];
if (
  invokedPath
  && realpathSync(resolve(invokedPath)) === realpathSync(fileURLToPath(import.meta.url))
) {
  void main().catch((error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

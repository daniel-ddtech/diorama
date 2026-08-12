import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

export const DEFAULT_CHROME_BINARY = "/Users/daniel/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

export interface LaunchChromeOptions {
  binary?: string;
  userDataDir: string;
  extensionDir: string;
  headless?: boolean;
  extraArgs?: string[];
}

export interface LaunchedChrome {
  proc: ChildProcess;
  wsUrl: string;
  kill(): void;
}

export function resolveChromeBinary(binary?: string): string {
  return binary ?? process.env.DIORAMA_CHROME ?? DEFAULT_CHROME_BINARY;
}

export function buildArgs({
  userDataDir,
  extensionDir,
  headless = true,
  extraArgs = [],
}: LaunchChromeOptions): string[] {
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    ...extraArgs,
  ];
  if (headless) args.unshift("--headless=new");
  return args;
}

export async function launchChrome(options: LaunchChromeOptions): Promise<LaunchedChrome> {
  const binary = resolveChromeBinary(options.binary);
  if (!existsSync(binary)) {
    throw new Error(
      `Chrome binary not found at ${JSON.stringify(binary)}. Pass opts.binary or set DIORAMA_CHROME.`,
    );
  }

  const args = buildArgs(options);
  const proc = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stderr = proc.stderr;
  if (!stderr) {
    proc.kill("SIGKILL");
    throw new Error("Chrome stderr was not available");
  }

  let wsUrl: string;
  try {
    wsUrl = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        stderr.off("data", onData);
        proc.off("error", onError);
        proc.off("exit", onExit);
      };
      const finish = (error?: Error, value?: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value as string);
      };
      const onData = (chunk: Buffer | string): void => {
        buffer += chunk.toString();
        const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match?.[1]) finish(undefined, match[1]);
      };
      const onError = (error: Error): void => {
        finish(new Error(`Chrome failed to start: ${error.message}`));
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        const status = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
        finish(new Error(`Chrome exited early (${status}): ${buffer.slice(-500)}`));
      };
      const timer = setTimeout(() => {
        finish(new Error(`No DevTools WebSocket URL after 20s: ${buffer.slice(-500)}`));
      }, 20_000);

      stderr.on("data", onData);
      proc.on("error", onError);
      proc.on("exit", onExit);
    });
  } catch (error) {
    proc.kill("SIGKILL");
    throw error;
  }

  return {
    proc,
    wsUrl,
    kill(): void {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    },
  };
}

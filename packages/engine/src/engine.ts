import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CdpClient } from "./cdp.js";
import {
  launchChrome,
  type LaunchedChrome,
  type LaunchChromeOptions,
} from "./launch.js";
import { makeTabsQueryShim } from "./shim.js";

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

interface TargetListResult {
  targetInfos: TargetInfo[];
}

interface CreateTargetResult {
  targetId: string;
}

interface CaptureScreenshotResult {
  data: string;
}

export interface ExtensionTarget {
  extensionId: string;
  swSession: string;
}

export interface ViewportOptions {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface StageTarget {
  targetId: string;
  session: string;
}

export interface OpenExtensionPageOptions extends ViewportOptions {
  shimTabId?: number;
}

export interface ScreenshotOptions {
  format: "jpeg" | "png" | "webp";
  quality?: number;
}

export interface CaptureEntry {
  name: string;
  session: string;
}

export interface CaptureLoopOptions {
  outDir: string;
  intervalMs: number;
}

export interface CaptureFrameTimes {
  name: string;
  times: number[];
}

export interface CaptureLoopResult {
  frames: CaptureFrameTimes[];
}

export interface CaptureLoop {
  stop(): Promise<CaptureLoopResult>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class Engine {
  readonly cdp: CdpClient;

  private closed = false;

  private constructor(
    private readonly chrome: LaunchedChrome,
    cdp: CdpClient,
  ) {
    this.cdp = cdp;
  }

  static async launch(options: LaunchChromeOptions): Promise<Engine> {
    const chrome = await launchChrome(options);
    const cdp = new CdpClient();
    try {
      await cdp.connect(chrome.wsUrl);
      await cdp.send("Target.setDiscoverTargets", { discover: true });
      return new Engine(chrome, cdp);
    } catch (error) {
      chrome.kill();
      await cdp.close();
      throw error;
    }
  }

  async findExtension(namePattern: RegExp): Promise<ExtensionTarget> {
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      const { targetInfos } = await this.cdp.send<TargetListResult>("Target.getTargets");
      const candidates = targetInfos.filter(
        (target) => target.type === "service_worker"
          && target.url.startsWith("chrome-extension://"),
      );

      for (const target of candidates) {
        let session: string | undefined;
        try {
          session = await this.cdp.attach(target.targetId);
          await this.cdp.send("Runtime.enable", {}, session);
          const name = await this.cdp.evaluate<string>(
            session,
            "chrome.runtime.getManifest().name",
          );
          namePattern.lastIndex = 0;
          if (namePattern.test(name)) {
            return {
              extensionId: new URL(target.url).host,
              swSession: session,
            };
          }
        } catch {
          // A service worker can disappear while targets are being inspected.
        }

        if (session) {
          try {
            await this.cdp.send("Target.detachFromTarget", { sessionId: session });
          } catch {
            // The target may already have gone away.
          }
        }
      }

      await delay(250);
    }

    throw new Error(`Extension service worker matching ${namePattern.toString()} was not found after 10s`);
  }

  async createStage(url: string, viewport: ViewportOptions): Promise<StageTarget> {
    const { targetId } = await this.cdp.send<CreateTargetResult>(
      "Target.createTarget",
      { url: "about:blank" },
    );
    const session = await this.cdp.attach(targetId);
    await this.cdp.send("Page.enable", {}, session);
    await this.cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { ...viewport, mobile: false },
      session,
    );
    await this.cdp.send("Page.navigate", { url }, session);
    return { targetId, session };
  }

  async resolveStageTabId(swSession: string, urlSubstring: string): Promise<number> {
    const tabId = await this.cdp.evaluate<number | null>(swSession, `(async () => {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        try {
          const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => location.href });
          if ((r?.result || "").includes(${JSON.stringify(urlSubstring)})) return t.id;
        } catch {}
      }
      return null;
    })()`);

    if (tabId === null) {
      throw new Error(`Could not resolve stage tab id for URL containing ${JSON.stringify(urlSubstring)}`);
    }
    return tabId;
  }

  async openExtensionPage(
    extensionId: string,
    pagePath: string,
    options: OpenExtensionPageOptions,
  ): Promise<StageTarget> {
    const { shimTabId, ...viewport } = options;
    const { targetId } = await this.cdp.send<CreateTargetResult>(
      "Target.createTarget",
      { url: "about:blank" },
    );
    const session = await this.cdp.attach(targetId);
    await this.cdp.send("Page.enable", {}, session);
    if (shimTabId !== undefined) {
      await this.cdp.send(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: makeTabsQueryShim(shimTabId) },
        session,
      );
    }
    await this.cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { ...viewport, mobile: false },
      session,
    );
    const normalizedPath = pagePath.replace(/^\/+/, "");
    await this.cdp.send(
      "Page.navigate",
      { url: `chrome-extension://${extensionId}/${normalizedPath}` },
      session,
    );
    return { targetId, session };
  }

  async seedStorage(swSession: string, data: object): Promise<void> {
    const serialized = JSON.stringify(data);
    await this.cdp.evaluate(swSession, `(async () => {
      await chrome.storage.local.set(${serialized});
    })()`);
  }

  async screenshot(session: string, options: ScreenshotOptions): Promise<Buffer> {
    const params: Record<string, unknown> = { format: options.format };
    if (options.quality !== undefined) params.quality = options.quality;
    const result = await this.cdp.send<CaptureScreenshotResult>(
      "Page.captureScreenshot",
      params,
      session,
    );
    return Buffer.from(result.data, "base64");
  }

  startCaptureLoop(entries: CaptureEntry[], options: CaptureLoopOptions): CaptureLoop {
    const states = entries.map(({ name, session }) => ({ name, session, times: [] as number[] }));
    mkdirSync(options.outDir, { recursive: true });
    for (const state of states) {
      mkdirSync(join(options.outDir, state.name), { recursive: true });
    }

    let running = true;
    let captureError: Error | undefined;
    const loop = (async (): Promise<void> => {
      try {
        while (running) {
          const timestamp = Date.now();
          await Promise.all(states.map(async (state) => {
            const index = state.times.length;
            const image = await this.screenshot(state.session, { format: "jpeg", quality: 85 });
            writeFileSync(
              join(options.outDir, state.name, `${String(index).padStart(5, "0")}.jpg`),
              image,
            );
            state.times.push(timestamp);
          }));
          if (running) await delay(options.intervalMs);
        }
      } catch (error) {
        captureError = toError(error);
        running = false;
      }
    })();

    let stopPromise: Promise<CaptureLoopResult> | undefined;
    return {
      stop: () => {
        stopPromise ??= (async () => {
          running = false;
          await loop;
          const result: CaptureLoopResult = {
            frames: states.map(({ name, times }) => ({ name, times })),
          };
          writeFileSync(
            join(options.outDir, "timing.json"),
            `${JSON.stringify(result, null, 2)}\n`,
          );
          if (captureError) throw captureError;
          return result;
        })();
        return stopPromise;
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.chrome.kill();
    await this.cdp.close();
  }
}

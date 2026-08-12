import { createReadStream, existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse as parsePath,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseBeatSheet,
  recordDemo,
  runDoctorChecks,
  type RecordDemoResult,
} from "@adlicio/diorama";

export interface CreateStudioServerOptions {
  port: number;
  stateDir?: string;
}

interface StudioProject {
  name: string;
  extensionPath: string;
  sheetYaml: string;
  updatedAt: string;
}

interface StoredRunMetadata {
  id: string;
  title: string;
  createdAt: string;
  status: "running" | "done" | "error";
  durationMs?: number;
  error?: string;
}

interface RunState {
  status: "running" | "done" | "error";
  logs: string[];
  listeners: Set<ServerResponse>;
  result?: RecordDemoResult;
  error?: string;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2 * 1024 * 1024) throw new HttpError(413, "request body is too large");
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new HttpError(400, "request body must be a JSON object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid JSON body");
  }
}

function requireAbsolutePath(value: string | null, fallback?: string): string {
  const requested = value ?? fallback;
  if (requested === undefined || !isAbsolute(requested)) {
    throw new HttpError(400, "path must be absolute");
  }
  return resolve(requested);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function readProjects(projectsPath: string): Promise<StudioProject[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(projectsPath, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is StudioProject => (
      typeof entry === "object"
      && entry !== null
      && typeof (entry as StudioProject).name === "string"
      && typeof (entry as StudioProject).extensionPath === "string"
      && typeof (entry as StudioProject).sheetYaml === "string"
      && typeof (entry as StudioProject).updatedAt === "string"
    ));
  } catch {
    return [];
  }
}

function sseEvent(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function terminalPayload(runId: string, state: RunState): { event: string; data: unknown } | undefined {
  if (state.status === "error") {
    return { event: "error", data: { message: state.error ?? "recording failed" } };
  }
  if (state.status !== "done" || state.result === undefined) return undefined;
  return {
    event: "done",
    data: {
      mp4Path: state.result.mp4Path,
      posterPath: state.result.posterPath,
      durationMs: state.result.durationMs,
      formats: state.result.formats,
      mp4Url: `/media/${encodeURIComponent(runId)}/${encodeURIComponent(basename(state.result.mp4Path))}`,
      posterUrl: `/media/${encodeURIComponent(runId)}/${encodeURIComponent(basename(state.result.posterPath))}`,
    },
  };
}

async function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  filePath: string,
  contentType: string,
  allowRange = false,
): Promise<void> {
  const info = await stat(filePath).catch(() => undefined);
  if (!info?.isFile()) throw new HttpError(404, "file not found");

  if (allowRange && request.headers.range !== undefined) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    if (!match || (match[1] === "" && match[2] === "")) {
      response.writeHead(416, { "content-range": `bytes */${info.size}` });
      response.end();
      return;
    }
    const suffixLength = match[1] === "" ? Number(match[2]) : undefined;
    const start = suffixLength === undefined
      ? Number(match[1])
      : Math.max(0, info.size - suffixLength);
    const end = match[2] === "" || suffixLength !== undefined
      ? info.size - 1
      : Math.min(Number(match[2]), info.size - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
      response.writeHead(416, { "content-range": `bytes */${info.size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      "content-type": contentType,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${info.size}`,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    createReadStream(filePath, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, {
    "content-type": contentType,
    "content-length": info.size,
    ...(allowRange ? { "accept-ranges": "bytes" } : {}),
    "cache-control": "no-store",
  });
  createReadStream(filePath).pipe(response);
}

async function findManifestAncestor(filePath: string): Promise<string | undefined> {
  let current = dirname(filePath);
  while (true) {
    if (await fileExists(join(current, "manifest.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function readRunMetadata(filePath: string): Promise<StoredRunMetadata | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as StoredRunMetadata;
  } catch {
    return undefined;
  }
}

export function createStudioServer(options: CreateStudioServerOptions): Server {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error("port must be an integer between 0 and 65535");
  }
  const stateDir = resolve(options.stateDir ?? join(homedir(), ".diorama"));
  const runsDir = join(stateDir, "runs");
  const projectsPath = join(stateDir, "studio.json");
  const appPath = fileURLToPath(new URL("../studio.html", import.meta.url));
  const activeRuns = new Map<string, RunState>();

  const addLog = (run: RunState, line: string): void => {
    run.logs.push(line);
    for (const listener of run.listeners) sseEvent(listener, "log", { line });
  };

  const finishListeners = (runId: string, run: RunState): void => {
    const terminal = terminalPayload(runId, run);
    if (!terminal) return;
    for (const listener of run.listeners) {
      sseEvent(listener, terminal.event, terminal.data);
      listener.end();
    }
    run.listeners.clear();
  };

  const executeRun = async (
    runId: string,
    runDir: string,
    sheetPath: string,
    title: string,
    createdAt: string,
    run: RunState,
  ): Promise<void> => {
    try {
      const result = await recordDemo({
        sheetPath,
        outDir: runDir,
        outPath: join(runDir, "recording.mp4"),
        posterPath: join(runDir, "poster.jpg"),
        log: (line) => addLog(run, line),
      });
      run.status = "done";
      run.result = result;
      await writeFile(join(runDir, "run.json"), `${JSON.stringify({
        id: runId,
        title,
        createdAt,
        status: "done",
        durationMs: result.durationMs,
      } satisfies StoredRunMetadata, null, 2)}\n`, "utf8");
    } catch (error) {
      run.status = "error";
      run.error = errorMessage(error);
      addLog(run, `Error: ${run.error}`);
      await writeFile(join(runDir, "run.json"), `${JSON.stringify({
        id: runId,
        title,
        createdAt,
        status: "error",
        error: run.error,
      } satisfies StoredRunMetadata, null, 2)}\n`, "utf8").catch(() => {});
    } finally {
      finishListeners(runId, run);
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");

    if (method === "GET" && url.pathname === "/") {
      const html = await readFile(appPath);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": html.length,
        "cache-control": "no-store",
      });
      response.end(html);
      return;
    }

    if (method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { checks: runDoctorChecks(), stateDir });
      return;
    }

    if (method === "GET" && url.pathname === "/api/browse") {
      const directoryPath = requireAbsolutePath(url.searchParams.get("path"), homedir());
      const info = await stat(directoryPath).catch(() => undefined);
      if (!info?.isDirectory()) throw new HttpError(404, "directory not found");
      const entries = (await readdir(directoryPath, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .sort((left, right) => left.name.localeCompare(right.name, undefined, {
          sensitivity: "base",
        }));
      sendJson(response, 200, {
        path: directoryPath,
        parent: directoryPath === parsePath(directoryPath).root
          ? null
          : dirname(directoryPath),
        entries: entries.map((entry) => ({
          name: entry.name,
          path: join(directoryPath, entry.name),
          hasManifest: existsSync(join(directoryPath, entry.name, "manifest.json")),
        })),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/manifest") {
      let directoryPath: string;
      try {
        directoryPath = requireAbsolutePath(url.searchParams.get("path"));
      } catch (error) {
        sendJson(response, error instanceof HttpError ? error.statusCode : 400, {
          ok: false,
          error: errorMessage(error),
        });
        return;
      }
      const manifestPath = join(directoryPath, "manifest.json");
      let contents: string;
      try {
        contents = await readFile(manifestPath, "utf8");
      } catch {
        sendJson(response, 404, { ok: false, error: "manifest.json not found" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents);
      } catch {
        sendJson(response, 400, { ok: false, error: "invalid manifest.json" });
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        sendJson(response, 400, { ok: false, error: "manifest.json must contain an object" });
        return;
      }
      const manifest = parsed as Record<string, unknown>;
      if (manifest.manifest_version !== 3) {
        sendJson(response, 400, { ok: false, error: "manifest_version must be 3" });
        return;
      }
      if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
        sendJson(response, 400, { ok: false, error: "manifest name is missing" });
        return;
      }
      if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
        sendJson(response, 400, { ok: false, error: "manifest version is missing" });
        return;
      }
      const action = typeof manifest.action === "object" && manifest.action !== null
        ? manifest.action as Record<string, unknown>
        : undefined;
      const popup = typeof action?.default_popup === "string" && action.default_popup !== ""
        ? action.default_popup
        : null;
      const icons = typeof manifest.icons === "object" && manifest.icons !== null
        ? Object.entries(manifest.icons as Record<string, unknown>)
          .filter((entry): entry is [string, string] => (
            Number.isFinite(Number(entry[0])) && typeof entry[1] === "string"
          ))
          .sort((left, right) => Number(right[0]) - Number(left[0]))
        : [];
      const iconCandidate = icons[0]?.[1];
      let iconPath: string | null = null;
      if (iconCandidate !== undefined) {
        const candidate = resolve(directoryPath, iconCandidate.replace(/^[/\\]+/, ""));
        const insideExtension = candidate.startsWith(`${directoryPath}${sep}`);
        if (insideExtension && extname(candidate).toLowerCase() === ".png" && await fileExists(candidate)) {
          iconPath = candidate;
        }
      }
      sendJson(response, 200, {
        ok: true,
        name: manifest.name,
        version: manifest.version,
        manifestVersion: 3,
        popup,
        iconPath,
        ...(popup === null ? { warnings: ["no action popup"] } : {}),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/icon") {
      const iconPath = requireAbsolutePath(url.searchParams.get("path"));
      if (extname(iconPath).toLowerCase() !== ".png" || basename(iconPath).startsWith(".")) {
        throw new HttpError(400, "icon must be a PNG file");
      }
      if (await findManifestAncestor(iconPath) === undefined) {
        throw new HttpError(400, "icon must be inside an extension directory");
      }
      await sendFile(request, response, iconPath, "image/png");
      return;
    }

    if (method === "GET" && url.pathname === "/api/projects") {
      sendJson(response, 200, await readProjects(projectsPath));
      return;
    }

    if (method === "POST" && url.pathname === "/api/projects") {
      const body = await readJsonBody(request);
      if (
        typeof body.name !== "string" || body.name.trim() === ""
        || typeof body.extensionPath !== "string" || !isAbsolute(body.extensionPath)
        || typeof body.sheetYaml !== "string"
      ) {
        throw new HttpError(400, "name, absolute extensionPath, and sheetYaml are required");
      }
      const project: StudioProject = {
        name: body.name.trim(),
        extensionPath: resolve(body.extensionPath),
        sheetYaml: body.sheetYaml,
        updatedAt: new Date().toISOString(),
      };
      const current = await readProjects(projectsPath);
      const projects = [
        project,
        ...current.filter((entry) => entry.extensionPath !== project.extensionPath),
      ].slice(0, 20);
      await mkdir(stateDir, { recursive: true });
      await writeFile(projectsPath, `${JSON.stringify(projects, null, 2)}\n`, "utf8");
      sendJson(response, 200, { ok: true, project });
      return;
    }

    if (method === "POST" && url.pathname === "/api/validate") {
      const body = await readJsonBody(request);
      if (typeof body.yaml !== "string") throw new HttpError(400, "yaml is required");
      try {
        const sheet = parseBeatSheet(body.yaml);
        sendJson(response, 200, {
          ok: true,
          title: sheet.title,
          stepCount: sheet.steps.length,
        });
      } catch (error) {
        sendJson(response, 200, { ok: false, error: errorMessage(error) });
      }
      return;
    }

    if (method === "POST" && url.pathname === "/api/record") {
      const body = await readJsonBody(request);
      if (typeof body.yaml !== "string") throw new HttpError(400, "yaml is required");
      if (body.outDir !== undefined && typeof body.outDir !== "string") {
        throw new HttpError(400, "outDir must be a string");
      }
      if (body.baseDir !== undefined && typeof body.baseDir !== "string") {
        throw new HttpError(400, "baseDir must be a string");
      }
      let sheet;
      try {
        sheet = parseBeatSheet(body.yaml);
      } catch (error) {
        throw new HttpError(400, errorMessage(error));
      }
      // The sheet is copied into the run dir, so relative paths inside it
      // would silently resolve against the wrong base. Rewrite them against
      // the caller's baseDir (where the YAML came from) before writing.
      let sheetYaml = body.yaml;
      if (body.baseDir) {
        if (!isAbsolute(body.baseDir)) throw new HttpError(400, "baseDir must be absolute");
        const resolveAgainst = (value: string): string => (
          isAbsolute(value) ? value : resolve(body.baseDir as string, value)
        );
        sheet.extension.path = resolveAgainst(sheet.extension.path);
        if (sheet.profile.dir) sheet.profile.dir = resolveAgainst(sheet.profile.dir);
        if (sheet.profile.seedStorage) sheet.profile.seedStorage = resolveAgainst(sheet.profile.seedStorage);
        sheetYaml = JSON.stringify(sheet, null, 2); // JSON is valid YAML 1.2
      }
      const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
      const runDir = join(runsDir, runId);
      const sheetPath = join(runDir, "demo.beats.yaml");
      const createdAt = new Date().toISOString();
      await mkdir(runDir, { recursive: true });
      await Promise.all([
        writeFile(sheetPath, sheetYaml, "utf8"),
        writeFile(join(runDir, "run.json"), `${JSON.stringify({
          id: runId,
          title: sheet.title,
          createdAt,
          status: "running",
        } satisfies StoredRunMetadata, null, 2)}\n`, "utf8"),
      ]);
      const run: RunState = {
        status: "running",
        logs: [],
        listeners: new Set(),
      };
      activeRuns.set(runId, run);
      setImmediate(() => {
        void executeRun(runId, runDir, sheetPath, sheet.title, createdAt, run);
      });
      sendJson(response, 202, { runId });
      return;
    }

    const streamMatch = /^\/api\/record\/([^/]+)\/stream$/.exec(url.pathname);
    if (method === "GET" && streamMatch?.[1]) {
      const runId = decodeURIComponent(streamMatch[1]);
      const run = activeRuns.get(runId);
      if (!run) throw new HttpError(404, "run not found");
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      response.flushHeaders();
      for (const line of run.logs) sseEvent(response, "log", { line });
      const terminal = terminalPayload(runId, run);
      if (terminal) {
        sseEvent(response, terminal.event, terminal.data);
        response.end();
      } else {
        run.listeners.add(response);
        response.once("close", () => run.listeners.delete(response));
      }
      return;
    }

    if (method === "GET" && url.pathname === "/api/runs") {
      const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
      const runs = await Promise.all(entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map(async (entry) => {
          const id = entry.name;
          const runDir = join(runsDir, id);
          const metadata = await readRunMetadata(join(runDir, "run.json"));
          let title = metadata?.title ?? id;
          try {
            title = parseBeatSheet(await readFile(join(runDir, "demo.beats.yaml"), "utf8")).title;
          } catch {
            // Preserve the metadata or directory fallback for malformed old runs.
          }
          const info = await stat(runDir);
          const mp4Name = await fileExists(join(runDir, "recording.mp4"))
            ? "recording.mp4"
            : null;
          const posterName = await fileExists(join(runDir, "poster.jpg"))
            ? "poster.jpg"
            : null;
          const memoryState = activeRuns.get(id);
          return {
            id,
            title,
            mp4: mp4Name !== null,
            mp4Exists: mp4Name !== null,
            posterUrl: posterName === null ? null : `/media/${encodeURIComponent(id)}/${posterName}`,
            mp4Url: mp4Name === null ? null : `/media/${encodeURIComponent(id)}/${mp4Name}`,
            createdAt: metadata?.createdAt ?? info.mtime.toISOString(),
            status: memoryState?.status ?? metadata?.status ?? (mp4Name ? "done" : "error"),
            ...(metadata?.durationMs === undefined ? {} : { durationMs: metadata.durationMs }),
          };
        }));
      runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      sendJson(response, 200, runs);
      return;
    }

    const mediaMatch = /^\/media\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && mediaMatch?.[1] && mediaMatch[2]) {
      let runId: string;
      let fileName: string;
      try {
        runId = decodeURIComponent(mediaMatch[1]);
        fileName = decodeURIComponent(mediaMatch[2]);
      } catch {
        throw new HttpError(400, "invalid media path");
      }
      if (!/^[a-z0-9]+$/.test(runId) || basename(fileName) !== fileName) {
        throw new HttpError(400, "invalid media path");
      }
      const extension = extname(fileName).toLowerCase();
      const contentTypes: Record<string, string> = {
        ".mp4": "video/mp4",
        ".jpg": "image/jpeg",
        ".png": "image/png",
      };
      const contentType = contentTypes[extension];
      if (contentType === undefined) throw new HttpError(404, "media file not found");
      const runDir = resolve(runsDir, runId);
      const mediaPath = resolve(runDir, fileName);
      if (!mediaPath.startsWith(`${runDir}${sep}`)) {
        throw new HttpError(400, "invalid media path");
      }
      await sendFile(request, response, mediaPath, contentType, extension === ".mp4");
      return;
    }

    throw new HttpError(404, "not found");
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJson(response, error instanceof HttpError ? error.statusCode : 500, {
        error: errorMessage(error),
      });
    });
  });
  server.listen(options.port, "127.0.0.1");
  return server;
}

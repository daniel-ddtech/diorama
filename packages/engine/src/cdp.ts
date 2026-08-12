export type CdpParams = Record<string, unknown>;

export type CdpEventHandler<T = unknown> = (
  params: T,
  sessionId: string | undefined,
) => void;

export interface EvaluateOptions {
  awaitPromise?: boolean;
  returnByValue?: boolean;
}

export interface WaitForExpressionOptions {
  timeoutMs?: number;
  pollMs?: number;
  label?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface CdpResponse {
  id?: number;
  method?: string;
  params?: unknown;
  sessionId?: string;
  result?: unknown;
  error?: {
    message: string;
    data?: string;
  };
}

interface RuntimeEvaluateResult<T> {
  result?: {
    value?: T;
  };
  exceptionDetails?: {
    text: string;
    exception?: {
      description?: string;
    };
  };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function decodeMessage(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  throw new Error("CDP WebSocket delivered an unsupported message type");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CdpClient {
  private nextId = 1;
  private socket: WebSocket | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Map<string, Set<CdpEventHandler>>();

  async connect(wsUrl: string): Promise<void> {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      throw new Error("CDP client is already connected");
    }

    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      let message: CdpResponse;
      try {
        message = JSON.parse(decodeMessage(event.data)) as CdpResponse;
      } catch (error) {
        const protocolError = new Error(`Invalid CDP message: ${toError(error).message}`);
        this.rejectPending(protocolError);
        socket.close();
        return;
      }
      this.handleMessage(message);
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.rejectPending(new Error("CDP WebSocket closed"));
    });

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error("CDP WebSocket connection error"));
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("CDP WebSocket closed before connecting"));
      };

      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      socket.addEventListener("close", onClose, { once: true });
    });
  }

  send<T = unknown>(method: string, params: CdpParams = {}, sessionId?: string): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP WebSocket is not open"));
    }

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });

      try {
        socket.send(JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }));
      } catch (error) {
        this.pending.delete(id);
        reject(toError(error));
      }
    });
  }

  on<T = unknown>(method: string, handler: CdpEventHandler<T>): () => void {
    let handlers = this.listeners.get(method);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(method, handlers);
    }
    handlers.add(handler as CdpEventHandler);

    return () => {
      handlers.delete(handler as CdpEventHandler);
      if (handlers.size === 0) this.listeners.delete(method);
    };
  }

  async attach(targetId: string): Promise<string> {
    const { sessionId } = await this.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
    );
    return sessionId;
  }

  async evaluate<T = unknown>(
    sessionId: string,
    expression: string,
    options: EvaluateOptions = {},
  ): Promise<T> {
    const {
      awaitPromise = true,
      returnByValue = true,
    } = options;
    const response = await this.send<RuntimeEvaluateResult<T>>(
      "Runtime.evaluate",
      { expression, awaitPromise, returnByValue },
      sessionId,
    );

    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.text;
      throw new Error(`Runtime.evaluate failed: ${detail}`);
    }

    return response.result?.value as T;
  }

  async waitForExpression(
    sessionId: string,
    expression: string,
    options: WaitForExpressionOptions = {},
  ): Promise<true> {
    const {
      timeoutMs = 20_000,
      pollMs = 250,
      label = expression.slice(0, 60),
    } = options;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      try {
        if (await this.evaluate(sessionId, expression)) return true;
      } catch {
        // Expressions commonly fail while a target is navigating; retry like the spike.
      }
      await delay(pollMs);
    }

    throw new Error(`waitForExpression timeout (${timeoutMs}ms): ${label}`);
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.rejectPending(new Error("CDP client closed"));
    if (!socket || socket.readyState === WebSocket.CLOSED) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      const onClose = (): void => {
        clearTimeout(timer);
        resolve();
      };
      socket.addEventListener("close", onClose, { once: true });
      socket.close();
    });
  }

  private handleMessage(message: CdpResponse): void {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);

      if (message.error) {
        const suffix = message.error.data ? ` ${message.error.data}` : "";
        pending.reject(new Error(`${message.error.message}${suffix}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (!message.method) return;
    const handlers = this.listeners.get(message.method);
    if (!handlers) return;
    for (const handler of handlers) handler(message.params, message.sessionId);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

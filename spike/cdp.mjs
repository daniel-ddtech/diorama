// Minimal flat-mode CDP client over Node's built-in WebSocket. Spike-grade.
import { spawn } from "child_process";

export async function launchChrome({ binary, userDataDir, extensionDir, headless = true }) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  ];
  if (headless) args.unshift("--headless=new");
  const proc = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { proc.stderr.off("data", onData); resolve(m[1]); }
    };
    proc.stderr.on("data", onData);
    proc.on("exit", (c) => reject(new Error(`chrome exited early (${c}): ${buf.slice(-500)}`)));
    setTimeout(() => reject(new Error("no DevTools ws url after 20s: " + buf.slice(-500))), 20000);
  });
  return { proc, wsUrl };
}

export class CDP {
  constructor() { this.nextId = 1; this.pending = new Map(); this.listeners = []; }

  async connect(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`)) : resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
    await new Promise((res, rej) => {
      this.ws.addEventListener("open", res, { once: true });
      this.ws.addEventListener("error", (e) => rej(new Error("ws error " + e.message)), { once: true });
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(fn) { this.listeners.push(fn); }

  async attach(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return sessionId;
  }

  // Convenience wrapper for CDP Runtime.evaluate (not JS eval()): runs our own
  // automation expressions inside the browser instance we launched, that is
  // the purpose of a CDP client. No untrusted input reaches this path.
  async eval(sessionId, expression, { awaitPromise = true } = {}) {
    const r = await this.send("Runtime.evaluate",
      { expression, awaitPromise, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error("eval failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }

  async waitFor(sessionId, expression, { timeoutMs = 20000, pollMs = 250, label = expression.slice(0, 60) } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(sessionId, expression)) return true; } catch {}
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`waitFor timeout (${timeoutMs}ms): ${label}`);
  }
}

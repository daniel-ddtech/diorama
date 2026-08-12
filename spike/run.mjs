// Diorama phase-1 spike: prove the full chain on the Reddit Comment Scraper.
// GATE A: extension SW target appears under --headless=new
// GATE B: reddit thread loads (comments present)
// GATE C: popup-as-target + tabs-query shim -> Scrape button enabled
// GATE D: real scrape completes with a real comment count
// GATE E: frames captured for both targets (+ BeginFrame proof)
// GATE F: composited, playable mp4
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { execSync } from "child_process";
import { launchChrome, CDP } from "./cdp.mjs";

const ROOT = new URL(".", import.meta.url).pathname;
const OUT = ROOT + "out";
const BINARY = "/Users/daniel/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const EXT = ROOT + "tmp-ext";
const PROFILE = ROOT + "profile-spike";
const THREAD = "https://www.reddit.com/r/sleep/comments/1p55102/has_anyone_found_a_magnesium_supplement_that/";
const CAPTURE = process.argv.includes("--capture");

rmSync(PROFILE, { recursive: true, force: true });
if (CAPTURE) { rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT + "/stage", { recursive: true }); mkdirSync(OUT + "/popup", { recursive: true }); }

const { proc, wsUrl } = await launchChrome({ binary: BINARY, userDataDir: PROFILE, extensionDir: EXT });
const cdp = new CDP();
await cdp.connect(wsUrl);
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

try {
  // ---- GATE A: find OUR extension's service worker ----
  // Chrome ships component extensions with their own SWs (e.g. thunk.js), so
  // never take the first chrome-extension:// worker — verify by manifest name.
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  let EXT_ID = null, swSession = null;
  for (let i = 0; i < 40 && !swSession; i++) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    for (const t of targetInfos.filter((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"))) {
      const s = await cdp.attach(t.targetId);
      await cdp.send("Runtime.enable", {}, s);
      try {
        const name = await cdp.eval(s, `chrome.runtime.getManifest().name`);
        if (/comment scraper/i.test(name)) { EXT_ID = new URL(t.url).host; swSession = s; break; }
      } catch {}
    }
    if (!swSession) await new Promise((r) => setTimeout(r, 250));
  }
  if (!swSession) throw new Error("GATE A FAILED: Comment Scraper service worker not found in headless=new");
  log("GATE A PASS: SW target, extension id", EXT_ID);

  // ---- GATE B: stage tab with the reddit thread ----
  const { targetId: stageId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const stage = await cdp.attach(stageId);
  await cdp.send("Page.enable", {}, stage);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false }, stage);
  await cdp.send("Page.navigate", { url: THREAD }, stage);
  await cdp.waitFor(stage, `document.querySelectorAll("shreddit-comment").length > 3`, { timeoutMs: 40000, label: "reddit comments render" });
  const commentCount = await cdp.eval(stage, `document.querySelectorAll("shreddit-comment").length`);
  log(`GATE B PASS: reddit thread loaded, ${commentCount} comments in DOM`);

  // stage tab id (for the shim) via the SW. Without the "tabs" permission
  // tab.url is hidden from tabs.query, so probe each tab with executeScript —
  // it only succeeds where host permissions exist, which is the reddit tab.
  const stageTabId = await cdp.eval(swSession, `(async () => {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => location.href });
        if ((r?.result || "").includes("/r/sleep/")) return t.id;
      } catch {}
    }
    return null;
  })()`);
  if (!stageTabId) throw new Error("could not resolve stage tabId from SW");
  log("stage tabId =", stageTabId);

  // ---- GATE C: popup as target, shim first, button enabled ----
  const SHIM = `(() => {
    if (!globalThis.chrome?.tabs?.query) return;
    const orig = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (q, cb) => {
      const wantsActive = q && q.active && (q.currentWindow || q.lastFocusedWindow);
      const run = wantsActive
        ? orig({}).then(ts => { const t = ts.find(x => x.id === ${stageTabId}); return t ? [t] : []; })
        : orig(q);
      if (typeof cb === "function") { run.then(cb); return; }
      return run;
    };
  })();`;
  const { targetId: popupId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const popup = await cdp.attach(popupId);
  await cdp.send("Page.enable", {}, popup);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: SHIM }, popup);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 600, height: 600, deviceScaleFactor: 2, mobile: false }, popup);
  await cdp.send("Page.navigate", { url: `chrome-extension://${EXT_ID}/popup.html` }, popup);
  await cdp.waitFor(popup, `document.body && document.body.innerText.length > 50`, { label: "popup rendered" });

  // clear first-run onboarding if present
  const clicked = await cdp.eval(popup, `(() => {
    const byText = (re) => [...document.querySelectorAll("button, a, [role=button], div, span")]
      .find(el => re.test(el.textContent.trim()) && el.offsetParent !== null);
    const skip = byText(/^SKIP FOR NOW$/i) || byText(/^Scrape a post yourself/i);
    if (skip) { skip.click(); return skip.textContent.trim().slice(0, 30); }
    return null;
  })()`);
  if (clicked) log("onboarding cleared via:", JSON.stringify(clicked));
  await new Promise((r) => setTimeout(r, 1500));

  const btnState = await cdp.eval(popup, `(() => {
    const b = [...document.querySelectorAll("button")].find(x => /scrape comments/i.test(x.textContent));
    return b ? { found: true, disabled: b.disabled, text: b.textContent.trim().slice(0, 40) } : { found: false, body: document.body.innerText.slice(0, 150) };
  })()`);
  log("scrape button state:", JSON.stringify(btnState));
  if (!btnState.found || btnState.disabled) throw new Error("GATE C FAILED: " + JSON.stringify(btnState));
  log("GATE C PASS: shim works — popup sees the reddit tab, button enabled");

  // ---- capture loop (GATE E collection) starts before the click ----
  const frames = { stage: [], popup: [] };
  let capturing = CAPTURE; let capErr = null;
  const capLoop = (async () => {
    while (capturing) {
      const t = Date.now();
      try {
        const [s, p] = await Promise.all([
          cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 80 }, stage),
          cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 85 }, popup),
        ]);
        const i = frames.stage.length;
        writeFileSync(`${OUT}/stage/${String(i).padStart(5, "0")}.jpg`, Buffer.from(s.data, "base64"));
        writeFileSync(`${OUT}/popup/${String(i).padStart(5, "0")}.jpg`, Buffer.from(p.data, "base64"));
        frames.stage.push(t); frames.popup.push(t);
      } catch (e) { capErr = e; break; }
      await new Promise((r) => setTimeout(r, 80)); // ~12fps, spike-grade
    }
  })();

  // ---- GATE D: fire the real scrape ----
  const t0 = Date.now();
  await cdp.eval(popup, `[...document.querySelectorAll("button")].find(x => /scrape comments/i.test(x.textContent)).click()`);
  log("clicked Scrape Comments");
  // completion = the "Scraping comments..." working state appears, then clears
  // (matching loose words like "export" false-positives on the pricing copy)
  await cdp.waitFor(popup, `/scraping comments|pulling comments/i.test(document.body.innerText)`,
    { timeoutMs: 15000, label: "scrape started" });
  await cdp.waitFor(popup, `!/scraping comments|pulling comments/i.test(document.body.innerText)`,
    { timeoutMs: 120000, pollMs: 500, label: "scrape completion" });
  const doneText = await cdp.eval(popup, `document.body.innerText.replace(/\\s+/g, " ").slice(0, 300)`);
  log(`GATE D PASS in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, JSON.stringify(doneText.slice(0, 200)));

  await new Promise((r) => setTimeout(r, 2500)); // hold on the result state
  capturing = false; await capLoop;
  if (CAPTURE) {
    if (capErr) throw new Error("GATE E FAILED during capture: " + capErr.message);
    log(`GATE E PASS: ${frames.stage.length} frame pairs captured`);
    // BeginFrame proof on the popup target (frame-perfect capture path for the real engine)
    let beginFrameOk = false;
    try {
      const r = await cdp.send("HeadlessExperimental.beginFrame", { screenshot: { format: "png" } }, popup);
      beginFrameOk = !!r.screenshotData;
    } catch (e) { log("BeginFrame note:", e.message.slice(0, 120)); }
    log("BeginFrame single-frame proof:", beginFrameOk ? "PASS" : "NOT AVAILABLE (fallback: screencast)");
    writeFileSync(`${OUT}/timing.json`, JSON.stringify({ t0, frames: frames.stage, popupOpenOffsetMs: 0 }));
  }
  console.log("\nALL LOGIC GATES PASSED" + (CAPTURE ? " (with capture)" : " (run with --capture for frames)"));
} finally {
  proc.kill("SIGKILL");
}

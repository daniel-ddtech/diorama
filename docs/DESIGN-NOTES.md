# Diorama

Agent-operable demo studio for Chrome extensions. Real Chrome runs headless as a
render engine; Diorama draws its own browser chrome around the live page and the
extension's real popup, and composites frame-perfect demo videos from beat sheets
that an AI agent (or a human) writes and re-runs on every release.

**One-line pitch:** your agent produces a polished, reproducible demo video of
your extension, and re-records it in CI whenever the UI changes.

## Why this doesn't already exist

- Screen recorders (Screen Studio, Cap, Tella) make human recordings pretty; they
  can't be driven by agents and know nothing about extensions.
- Automation frameworks (Playwright, Puppeteer) can't touch browser UI: an action
  popup is not page DOM, `chrome.action.openPopup()` is focus-gated and flaky
  under automation (verified 2026-08-12: fails "no active browser window" from
  background, "failed to open popup" even after OS-level activation).
- Chrome's own Recorder doesn't know extensions exist.

Nobody owns "agent → beautiful extension demo." ~140k Web Store extensions all
need store screenshots/videos every release, and they all rot.

## Architecture: real engine, synthetic chrome

Chrome for Testing runs `--headless=new --load-extension` as an offscreen
engine. Nothing of Chrome's real UI is ever shown. Diorama renders its own
browser frame (tab bar, omnibox, toolbar icon) and composites:

    drawn browser chrome
      + live page pixels        (CDP screencast / BeginFrame capture)
      + real popup pixels       (popup.html opened as an ordinary CDP target)
      + synthetic smooth cursor (every event's coords are machine-known)
    → frame-perfect mp4 + poster frames

### The popup shim, the key unlock

The extension's real `popup.html` is opened as a plain CDP target in the same
profile: same service worker, same storage, same plan/auth state, genuinely the
extension's code. Its only defect as a target is that
`chrome.tabs.query({active: true, currentWindow: true})` resolves to itself
instead of the stage tab. Diorama injects a tiny shim
(`Page.addScriptToEvaluateOnNewDocument` on `chrome-extension://` targets) that
rewrites active-tab resolution to the stage tab. Works for ANY extension, zero
modification. Everything else runs unmodified -
`chrome.scripting.executeScript({target:{tabId}})` takes an explicit tab id and
doesn't care about focus. Content-script overlay extensions need no shim at all
(their UI lives in the page).

### What the architecture buys

- **No macOS screen-recording permission**, no screen is recorded; frames come
  out of CDP.
- **No focus/blur fragility**, nothing depends on OS window focus (real popups
  close on blur; we have no real popup window).
- **Frame-perfect 60fps**, headless BeginFrame mode pulls frames: advance
  virtual clock → render → capture. No dropped frames ever. (The Remotion trick
  applied to live browser sessions.)
- **Runs in CI**, the engine is Node+CDP, headless. "Re-record the demo" is a
  CI job on every release.
- **Brand-clean output**, the browser frame is ours: no bookmark clutter, no
  profile avatar, retina at any scale, light/dark variants, not Chrome's trade
  dress.

### Trade-off

Output shows a *stylized* browser, not literally Chrome. Right for store assets
and landing pages; a headful "live mode" (real window + ScreenCaptureKit) stays
as an escape hatch for forensically authentic captures.

## Components

1. **Engine/session manager**, launch Chrome for Testing with extension +
   per-project profile (auth/plan state seeded via `chrome.storage`), CDP port.
2. **Driver**, CDP client executing beat sheets: navigate, click, wait,
   open-popup(shimmed), camera hints.
3. **Compositor/renderer**, BeginFrame capture of stage + popup targets,
   HTML/canvas-rendered browser frame, synthetic cursor, ffmpeg encode to web
   profiles + poster frame.
4. **Agent surface**, local MCP server: `launch_session`, `navigate`, `click`,
   `open_popup`, `start/stop_recording`, `mark_beat`, `export`. Beat sheet
   (YAML) lives in the extension's own repo.
5. **Mac app (later)**, SwiftUI shell: live composite preview, beat-sheet
   editing, one-click export. Polish layer, not load-bearing.

## MVP spike (phase 1)

One chain, headless, guinea pig = Reddit Comment Scraper
(`~/Developer/RedditCommentScraper`, loads unpacked):

1. `--headless=new --load-extension` + magnesium thread
   (https://www.reddit.com/r/sleep/comments/1p55102/has_anyone_found_a_magnesium_supplement_that/)
2. Open `popup.html` as target with tabs-query shim
3. Click "Scrape Comments" → confirm real comments land
4. Pull synchronized frames of both targets
5. Composite inside an HTML browser frame → watchable mp4

First output doubles as the replacement landing-page demo video for
hookcollective (`public/videos/extension-scrape-demo.mp4` + poster; also used on
`src/app/welcome/page.tsx`).

## Facts verified by the phase-1 spike (2026-08-12, spike/run.mjs, ALL GATES PASSED)

- `--headless=new --load-extension` runs the MV3 extension fully: SW alive,
  popup renders, **real scrape completes** ("Scraped 82 of 93 comments" off the
  live magnesium thread) in ~1.5s.
- **The tabs-query shim works.** Popup opened as a CDP target with
  `Page.addScriptToEvaluateOnNewDocument` sees the stage tab as active; Scrape
  button enables; `chrome.scripting.executeScript` runs unmodified.
- **`HeadlessExperimental.beginFrame` no longer exists** in headless=new (148).
  Engine capture = screenshot/screencast loop (+ virtual time for determinism
  later). PLAN's fallback is now the main path.
- **Component-extension trap:** Chrome ships its own chrome-extension:// service
  workers (e.g. thunk.js). Select the SW by `getManifest().name`, never "first
  extension target".
- **Without the `tabs` permission, `tab.url` is hidden** from `tabs.query`.
  Resolve the stage tabId by probing tabs with `executeScript` (succeeds only
  where host permissions exist), no manifest patching needed when the
  extension already declares host permissions (Comment Scraper declares
  `https://*.reddit.com/*`; the activeTab concern from the design session was
  moot).
- **Completion detection must be scoped**: loose word-matching false-positived
  on "export" in the popup's own pricing copy. Wait for the working state
  ("Scraping comments…") to appear then clear.
- Composite v0 (drawn chrome frame + stage + popup via ffmpeg overlay) looks
  right: `spike/out/spike-demo.mp4` + `poster.jpg`, 2560×1800.
- Spike-visible polish items for the real compositor: log into Reddit or hide
  the logged-out sidebar/promoted posts (profile seeding), favicon in the drawn
  tab, popup shadow/rounded corners, beat-paced timing (scrape is fast; the
  demo needs holds and scrolls).

## Facts verified during design (2026-08-12)

- Comment Scraper popup renders fine as a plain page (600×600), drivable DOM.
- Scrape button correctly disables when active tab isn't a supported page -
  this is the exact behavior the shim fixes.
- Extension loads clean in Playwright persistent context (id
  `gfmafjkhloigpbkibadllpabodmjppmc` in test profile).
- Auth lives in `chrome.storage.local` keys `user` + `authToken`
  (`js/auth-session.js`), seedable, needs a real token to show ALL ACCESS.
- Active-tab resolution: `js/scraper.js:125`, `popup.js:325`.
- Chrome for Testing here: 148.0.7778.96 (openPopup min is 127, version was
  never the problem; focus gating is).

## Name

Diorama: a real, living scene composed inside a crafted display box. Runners-up
considered: Backlot, Zoetrope.

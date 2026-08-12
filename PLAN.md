# Diorama, full build plan

Goal: **v1.0 = "an agent (or human) runs `diorama record demo.yaml` and gets a
polished, frame-perfect demo video of a Chrome extension, reproducibly, on any
machine, with no screen-recording permissions."**

Definition of done for v1.0 (all four, no exceptions):

1. `diorama record beats.yaml` works on a fresh Mac: produces `out.mp4` +
   `poster.jpg` from a beat sheet, headless, no OS permissions.
2. The MCP server exposes the same power to agents; a Claude Code session can
   author a beat sheet, run it, and get the video path back.
3. Dogfooded end-to-end: the Reddit Comment Scraper demo (magnesium thread) is
   recorded by Diorama and **shipped live on hookcollective** (replaces
   `public/videos/extension-scrape-demo.mp4` + poster; also used by
   `/welcome`).
4. README/docs are good enough that an outside extension developer could use it
   unassisted.

Out of scope for v1.0 (explicitly): Mac SwiftUI shell (post-v1 polish layer),
Windows/Linux support promises (should mostly work, headless CDP, but not
verified), Web Store upload automation, captions/voiceover, side-panel and
DevTools-panel surfaces (architecture supports them; ship popups + content
scripts first).

## Repo layout (npm workspaces, TypeScript, Node 22, ESM)

    packages/
      engine/        # Chrome lifecycle + CDP client + popup shim
      beats/         # beat-sheet schema (zod) + executor
      compositor/    # frame pipeline: browser-frame render, cursor, camera, encode
      cli/           # `diorama` bin: init, record, doctor
      mcp/           # local MCP server wrapping the same core
    frames/          # browser-frame themes (HTML/CSS) used by compositor
    examples/
      comment-scraper/   # the dogfood beat sheet
    docs/

## Tech decisions (made; revisit only on evidence)

- **Raw CDP** (chrome-remote-interface or hand-rolled ws client), NOT
  playwright/puppeteer: we need `HeadlessExperimental.beginFrame`, screencast
  control, and `Page.addScriptToEvaluateOnNewDocument` on
  `chrome-extension://` targets, and no framework baggage in a product.
- **Engine browser:** Chrome for Testing, pinned version per project, launched
  `--headless=new --load-extension=<path> --remote-debugging-port=0`.
- **Capture:** BeginFrame-driven (advance virtual clock → render → capture) for
  frame-perfect 60fps of BOTH targets (stage page + popup target), falling back
  to `Page.startScreencast` in live/headful mode.
- **Composite v1:** ffmpeg, overlay popup frames onto stage frames inside a
  pre-rendered browser-frame PNG (from `frames/` HTML via a capture pass),
  synthetic cursor drawn as an overlay track from the executor's event log.
  (v2 idea, parked: an HTML compositor page rendering the whole scene live.)
- **Cursor:** never a recorded cursor. The executor knows every event's
  coordinates and timestamps; generate a smooth bezier path between them,
  render pngs → ffmpeg overlay track.
- **Beat sheets:** YAML, zod-validated, versioned (`version: 1`). Live in the
  *extension's* repo, not Diorama's.
- **Auth/profile seeding:** per-project Chrome profile dir +
  `chrome.storage.local` seeding via the extension's service-worker target
  (evaluate `chrome.storage.local.set(...)` from env/JSON file, secrets never
  in beat sheets).

## Beat sheet v1 schema (draft)

```yaml
version: 1
title: comment-scraper-reddit
viewport: { width: 1280, height: 800, scale: 2 }
frame: { theme: dark, url: "reddit.com/r/sleep, magnesium…", extensionIcon: ./assets/icon128.png }
extension: { path: ~/Developer/RedditCommentScraper, seedStorage: ./secrets/storage.json }
output: { fps: 60, format: mp4, poster: 2.5s, profiles: [web, cws-1280x800] }
steps:
  - goto: https://www.reddit.com/r/sleep/comments/1p55102/...
  - wait: { selector: "shreddit-comment", timeoutMs: 15000 }
  - camera: { zoom: 1.0 }
  - openPopup: {}                 # opens popup.html target w/ tabs-query shim, anchored under drawn icon
  - wait: { target: popup, selector: "text=Scrape Comments" }
  - click: { target: popup, selector: "text=Scrape Comments" }
  - camera: { zoom: 1.4, focus: popup }
  - wait: { target: popup, selector: "text=/comments scraped/i", timeoutMs: 60000 }
  - hold: 2000
```

Verbs v1: `goto, wait, click, type, scroll, hover, openPopup, closePopup,
camera, hold, mark` (named beat for poster/chapters). Every verb accepts
`target: page | popup` (default page).

## MCP tool surface (v1)

`launch_session, close_session, navigate, click, type, scroll, open_popup,
run_beats (path|inline), record_start, record_stop, export, doctor`, thin
wrappers over the same core the CLI uses; returns file paths + structured
status. Ship as `diorama mcp` (stdio).

## Phases → tasks

Phase numbers below map 1:1 to the tracked task list.

1. **Spike the full chain** (riskiest first, throwaway code allowed):
   headless+extension → popup target + tabs-query shim → real scrape fires →
   BeginFrame frames of both targets → crude ffmpeg composite → watchable mp4.
   Kill-or-commit gate: if the shim or BeginFrame capture fails structurally,
   redesign before any scaffolding. Verified facts + refs in README.
2. **Scaffold + engine package**: workspaces, tsconfig, vitest; port the spike
   into `packages/engine` with real lifecycle (launch/attach/cleanup, target
   discovery, shim injection on chrome-extension:// targets, storage seeding).
3. **Beats package**: zod schema, executor emitting a timestamped event log
   (the compositor's cursor/camera input), per-verb tests against a fixture
   extension (build a tiny test extension in-repo; don't depend on
   RedditCommentScraper for tests).
4. **Compositor package**: frame themes (dark/light), popup anchoring,
   synthetic cursor track, camera zoom/pan from `camera` beats, ffmpeg encode
   profiles (web mp4, CWS 1280x800), poster export.
5. **CLI**: `diorama init` (writes starter beat sheet), `record`, `doctor`
   (checks CfT binary, ffmpeg, extension path). npx-runnable.
6. **MCP server**: tool surface above; test from a live Claude Code session.
7. **Dogfood**: `examples/comment-scraper` beat sheet, seeded ALL ACCESS
   session (token from Daniel), record the magnesium-thread demo, replace
   hookcollective's `extension-scrape-demo.mp4` + `extension-scrape-poster.jpg`,
   verify on prod (Railway deploy gotcha: check the build actually went live).
8. **Docs + release**: README rewrite for outsiders, beat-sheet reference,
   npm publish under a scoped name, decide license (default: proprietary until
   a deliberate OSS call).

Post-v1 backlog (do not start before v1.0 ships): SwiftUI preview/editor app,
side-panel + DevTools-panel surfaces, content-script-overlay camera presets,
CI recipe (GitHub Action), shim compat matrix beyond tabs.query
(windows.getLastFocused, tabs.captureVisibleTab), HTML live compositor (v2),
Windows/Linux verification.

## Known risks, with mitigations

- **BeginFrame + extensions in headless=new**: least-proven combination
  (spike exists to prove it). Fallback: screencast capture at fixed fps -
  loses frame-perfection, keeps everything else.
- **Popup pixel fidelity**: popup-as-target renders at our chosen size; real
  popups size to content ≤800x600. Mitigation: measure content size after
  load, resize target viewport to match before recording.
- **Scrape timing variance** (network): beat sheets use condition-waits, and
  BeginFrame's virtual clock makes waits cost zero wall-clock in the output.
- **Chrome updates**: pin CfT per project; `doctor` verifies.

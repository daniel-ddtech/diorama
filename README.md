# Diorama

Reproducible demo videos for Chrome extensions, recorded by agents or humans
from a declarative beat sheet.

```bash
diorama record demo.beats.yaml
# → demo.mp4 + poster.jpg — real extension, real page, frame-composited
```

Your extension runs for real — real service worker, real popup code, real
network — inside a headless Chrome engine. Diorama drives it from a YAML
**beat sheet**, captures every target, and composites the result inside a
clean, drawn browser frame with a synthetic cursor. No screen recording, no
OS permissions, no window juggling. Change the beat sheet or your extension's
UI, run one command, get a pixel-perfect re-record. It also speaks MCP, so
your coding agent can author and record demos for you.

**Why it exists:** action popups are browser chrome — Playwright and Puppeteer
cannot open or film them, `chrome.action.openPopup()` is focus-gated under
automation, and screen recorders can't be driven by agents. Diorama opens your
real `popup.html` as a driven page with a small `tabs.query` shim so it sees
the stage tab as active, which works for any extension unmodified.

## Requirements

- Node 22+
- Chrome for Testing (`DIORAMA_CHROME` env var, or the auto-detected default)
- ffmpeg + ffprobe on PATH (`DIORAMA_FFMPEG` / `DIORAMA_FFPROBE` to override)

Check everything at once:

```bash
diorama doctor
```

## Quickstart

```bash
diorama init                 # writes demo.beats.yaml
$EDITOR demo.beats.yaml      # point it at your extension + target page
diorama record demo.beats.yaml --out out/
```

`record` launches the engine with your unpacked extension, executes the steps
with real input events (CDP mouse/keyboard, not DOM .click()), captures the
page and popup, and renders `out/<title>.mp4` plus a poster frame. Add
`--keep-run` to keep the raw frames, `events.json`, and `timing.json`.

## Beat sheet

```yaml
version: 1
title: My extension demo
viewport: { width: 1280, height: 860, scale: 2 }   # +100px drawn toolbar → 4:3 output
extension:
  path: ../my-extension          # unpacked dir, relative to this file
  popup: { width: 600, height: 600 }
steps:
  - verb: goto
    url: https://example.com/somewhere-interesting
  - verb: wait
    selector: ".content"
  - verb: openPopup              # the real popup, shimmed to see this tab
  - verb: click
    target: popup
    selector: text=Do the thing
  - verb: wait
    target: popup
    expression: /done/i.test(document.body.innerText)
  - verb: hold
    ms: 1500
  - verb: mark                   # poster frame is taken at the last mark
    name: end
```

| verb | fields | notes |
| --- | --- | --- |
| `goto` | `url` | first goto creates the stage tab |
| `wait` | `selector` \| `ms` \| `expression`, `timeoutMs` | exactly one condition; `target: page\|popup` |
| `click` | `selector`, `target` | real mouse move → press → release at the element |
| `type` | `selector`, `text`, `perCharMs` | clicks first, then types per character |
| `scroll` | `deltaY`, `steps`, `stepMs`, `target` | stepped wheel events |
| `hover` | `selector`, `target` | mouse move only |
| `openPopup` / `closePopup` | — | opens `extension.popup` sized popup with the tabs-query shim |
| `camera` | `zoom`, `focus`, `ms` | recorded for the compositor (zoom/pan planned) |
| `hold` | `ms` | let a state breathe |
| `mark` | `name` | names a beat; last mark = poster frame |

Selectors are CSS, or `text=...` for a case-insensitive innermost visible text
match.

## MCP server (for agents)

```bash
claude mcp add diorama -- node <repo>/packages/mcp/dist/main.js
```

Tools: `record_demo`, `validate_sheet`, `doctor`, and stateful interactive
sessions — `launch_session`, `open_popup`, `click`, `type_text`, `navigate`,
`screenshot`, `close_session` — so an agent can explore your extension live,
write the beat sheet, validate it, and record, all without leaving chat.

## How it works

Chrome for Testing runs `--headless=new --load-extension` as an offscreen
render engine; nothing of Chrome's own UI is ever filmed. The popup is opened
as an ordinary CDP target in the same profile (same service worker, storage,
and state), with `chrome.tabs.query({active: true, currentWindow: true})`
shimmed to resolve to the stage tab — the one API a popup-as-page gets wrong.
The executor logs every input event with coordinates and timestamps; the
compositor maps captured frames onto a fixed-fps timeline, draws the browser
frame from an HTML theme (`frames/`), overlays the popup under the toolbar
icon with a fade, animates a synthetic cursor along eased piecewise paths,
and hands ffmpeg a fully terminating filter graph.

Full design history and verified engine facts: [docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md).

## Example

[`examples/comment-scraper`](examples/comment-scraper) records the Reddit
Comment Scraper extension scraping a live r/sleep thread — the demo shipped on
[tryadlicio.com](https://tryadlicio.com). 11 seconds, 631KB, one command to
re-record.

## Development

npm workspaces: `engine` (zero-dep CDP client + Chrome lifecycle), `beats`
(schema + executor), `compositor` (plan + ffmpeg render), `cli`, `mcp`.

```bash
npm install
npm run build          # tsc -b, strict
npm test               # unit tests
DIORAMA_IT=1 npx vitest run    # + live integrations (launches Chrome, runs ffmpeg)
```

## Status

v0.1.0 — working end to end (engine, beats, compositor, CLI, MCP, dogfooded
in production). Pre-release: not yet on npm; license not yet chosen. Planned
next: camera zoom/pan rendering, profile seeding for logged-in stage sessions,
side-panel and DevTools-panel surfaces, CI recipe.

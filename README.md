# Diorama

Reproducible demo videos for Chrome extensions. You describe the demo in a
YAML beat sheet, Diorama records it.

```bash
diorama record demo.beats.yaml
# -> demo.mp4 + poster.jpg
```

Your extension runs for real (service worker, popup code, network) inside a
headless Chrome that Diorama controls. It executes your steps, captures the
page and the popup, and composites everything into a clean drawn browser frame
with a synthetic cursor. There is no screen recording involved and no macOS
permission dialogs. When your extension UI changes, you run the command again
and get a fresh pixel-perfect video. It also speaks MCP, so a coding agent can
write and record demos for you.

The reason this tool exists: extension popups are browser chrome. Playwright
and Puppeteer can't open or film them, `chrome.action.openPopup()` fails in
weird ways under automation, and screen recorders can't be scripted. Diorama
loads your real `popup.html` as a driven page and patches `chrome.tabs.query`
so it sees the stage tab as active. That works for any extension without
modifying it.

## Requirements

- Node 22+
- Chrome for Testing (set `DIORAMA_CHROME`, or have a Playwright Chromium
  installed: `npx playwright install chromium`)
- ffmpeg and ffprobe on PATH (`DIORAMA_FFMPEG` / `DIORAMA_FFPROBE` to override)

```bash
diorama doctor   # checks all of the above
```

## Quickstart

```bash
diorama init                 # writes demo.beats.yaml
$EDITOR demo.beats.yaml      # point it at your extension and a target page
diorama record demo.beats.yaml --out out/
```

`record` launches Chrome with your unpacked extension, runs the steps with
real input events (CDP mouse and keyboard, not DOM .click()), captures both
targets, and renders `out/<title>.mp4` plus a poster frame. `--keep-run`
keeps the raw frames, `events.json`, and `timing.json`.

## Beat sheet

```yaml
version: 1
title: My extension demo
viewport: { width: 1280, height: 860, scale: 2 }   # +100px toolbar = 4:3 output
extension:
  path: ../my-extension          # unpacked dir, relative to this file
  popup: { width: 600, height: 600 }
steps:
  - verb: goto
    url: https://example.com/somewhere-interesting
  - verb: wait
    selector: ".content"
  - verb: openPopup
  - verb: click
    target: popup
    selector: text=Do the thing
  - verb: wait
    target: popup
    expression: /done/i.test(document.body.innerText)
  - verb: hold
    ms: 1500
  - verb: mark
    name: end
```

| verb | fields | notes |
| --- | --- | --- |
| `goto` | `url` | first goto creates the stage tab |
| `wait` | `selector` \| `ms` \| `expression`, `timeoutMs` | exactly one condition; `target: page\|popup` |
| `click` | `selector`, `target` | real mouse move, press, release at the element |
| `type` | `selector`, `text`, `perCharMs` | clicks first, then types per character |
| `scroll` | `deltaY`, `steps`, `stepMs`, `target` | stepped wheel events |
| `hover` | `selector`, `target` | mouse move only |
| `openPopup` / `closePopup` | | opens the real popup with the tabs.query patch |
| `camera` | `zoom`, `focus`, `ms` | eased zoom/pan rendered into the video |
| `hold` | `ms` | let a state breathe |
| `mark` | `name` | names a beat; the last mark becomes the poster frame |

Top-level customization blocks (all optional):

```yaml
frame:                     # the drawn browser chrome
  theme: dark              # dark | light | ./path/to/your-theme.html
  url: reddit.com/r/sleep  # omnibox text, defaults to the last goto URL
  title: My demo           # tab text, defaults to the sheet title
profile:
  dir: ./chrome-profile    # persistent profile: stay logged in across runs
  seedStorage: ./seed.json # chrome.storage.local seed for the extension
cursor:
  scale: 1.0               # cursor size multiplier
  ripple: true             # click ripple animation
  shadow: true             # drop shadow under the cursor
output:
  fps: 30
  holdTailMs: 2000
  endCard: true            # false, or { title: "...", subtitle: "..." }
  posterAt: scraped        # mark name or milliseconds; default: last mark
  formats:                 # extra renders from the same recording
    - { name: cws, width: 1280, height: 800, fit: cover, crf: 26 }
```

The `extension.popup` block accepts `autoSize: true` (measure the popup's real
content size and match it) and `position: right | left`. The `camera` verb
zooms between 1 and 2.5 with an eased move over `ms` milliseconds, focused on
`page` or `popup`.

Selectors are CSS, or `text=...` for a case-insensitive match on visible text.

## Studio (visual UI)

```bash
diorama-studio            # opens http://localhost:4517
```

A local web app over the same engine: pick your extension folder (manifest
validated instantly), set the stage URL, viewport and theme, build the steps
in an editor with a live YAML preview, then record with streaming progress
and watch the result inline. Past runs live in the Library. Everything the
studio does round-trips through the same beat-sheet YAML the CLI and MCP use.

## For AI agents

Two ways in. The MCP server gives chat agents live tools; the bundled skill
teaches shell-capable agents (Claude Code, Codex) the CLI workflow:
`.claude/skills/record-extension-demo/` ships in this repo, so Claude Code
picks it up automatically when working inside it, and you can copy it into
your extension's repo or `~/.claude/skills/` to make "record a demo of this
extension" a one-line request anywhere.

## MCP server (for agents)

```bash
claude mcp add diorama -- node <repo>/packages/mcp/dist/main.js
```

Tools: `record_demo`, `validate_sheet`, `doctor`, and stateful interactive
sessions (`launch_session`, `open_popup`, `click`, `type_text`, `navigate`,
`screenshot`, `close_session`). An agent can explore your extension live,
write the beat sheet, validate it, and record, all from chat.

## How it works

Chrome for Testing runs with `--headless=new --load-extension` as an offscreen
render engine. None of Chrome's own UI is filmed. The popup is opened as an
ordinary CDP target in the same profile (same service worker, storage, and
state), with `chrome.tabs.query({active: true, currentWindow: true})` patched
to resolve to the stage tab, which is the one API a popup-as-page gets wrong.
The executor logs every input event with coordinates and timestamps. The
compositor maps captured frames onto a fixed-fps timeline, draws the browser
frame from an HTML theme in `frames/`, overlays the popup under the toolbar
icon, animates the cursor along eased paths, and hands ffmpeg a filter graph
with an explicit duration.

Design history and the engine facts we verified the hard way are in
[docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md).

## Example

[`examples/comment-scraper`](examples/comment-scraper) records the Reddit
Comment Scraper extension scraping a live r/sleep thread. That exact video
runs on [tryadlicio.com](https://tryadlicio.com). 11 seconds, 631KB, one
command to re-record.

## Development

npm workspaces: `engine` (zero-dep CDP client and Chrome lifecycle), `beats`
(schema and executor), `compositor` (plan and ffmpeg render), `cli`, `mcp`.

```bash
npm install
npm run build          # tsc -b, strict
npm test               # unit tests
DIORAMA_IT=1 npx vitest run    # plus live integrations (launches Chrome, runs ffmpeg)
```

## Status and license

v0.1.0, MIT. Working end to end and used in production for our own extension
demo. Built by [Adlicio](https://tryadlicio.com) and maintained as we use it:
issues and PRs are welcome, response times are not guaranteed. On the list:
a local studio UI, side panel and DevTools panel surfaces, a CI recipe.

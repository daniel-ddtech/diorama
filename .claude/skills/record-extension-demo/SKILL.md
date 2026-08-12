---
name: record-extension-demo
description: Record a polished demo video of a Chrome extension with Diorama. Use when asked to create, update, or re-record an extension demo, produce Chrome Web Store assets, or turn an extension feature into a video.
---

# Record an extension demo with Diorama

Diorama records real Chrome extensions headlessly from a YAML beat sheet and
composites a finished mp4 with a drawn browser frame, synthetic cursor, click
ripples, and camera moves. No screen recording, no OS permissions.

## Workflow

1. Check the environment: `diorama doctor` (or `node <diorama>/packages/cli/dist/main.js doctor`).
   Needs Chrome for Testing (DIORAMA_CHROME or a Playwright Chromium) and ffmpeg.
2. Find the extension's unpacked directory (contains manifest.json, must be
   Manifest v3). Read the manifest to learn the popup path and the extension name.
3. Write a beat sheet. Start from `diorama init` or this shape:

```yaml
version: 1
title: My extension demo
viewport: { width: 1280, height: 860, scale: 2 }   # +100px toolbar = 4:3
extension:
  path: /abs/path/to/extension
  popup: { width: 600, height: 600, autoSize: true }
steps:
  - verb: goto
    url: https://the-page-the-extension-works-on.example
  - verb: wait
    selector: "css-or-text=selector"
  - verb: openPopup
  - verb: camera
    zoom: 1.35
    focus: popup
    ms: 700
  - verb: click
    target: popup
    selector: text=The Button Label
  - verb: wait
    target: popup
    expression: /done|complete/i.test(document.body.innerText)
  - verb: hold
    ms: 1200
  - verb: mark
    name: end
```

Verbs: goto, wait (selector | ms | expression), click, type, scroll, hover,
openPopup, closePopup, camera (zoom 1-2.5, focus page|popup, ms), hold, mark.
`text=` selectors match visible text case-insensitively. The last mark is the
poster frame. Optional blocks: frame (theme dark|light|custom html path, url,
title), profile (dir, seedStorage), cursor (scale, ripple, shadow), output
(fps, endCard true|false|{title,subtitle}, posterAt, formats list).

4. Record: `diorama record demo.beats.yaml --out out/ --keep-run`.
5. Inspect the result before declaring success: extract frames with ffmpeg
   (`ffmpeg -ss <t> -i out/<title>.mp4 -frames:v 1 check.jpg`) and view them.
   Common fixes: add wait steps before clicks that miss, add holds so states
   breathe, adjust camera timing to land after UI settles.
6. Iterate by editing the sheet and re-running. Recordings are reproducible.

## Page-only recordings (no extension)

Omit the `extension:` block entirely to record any web flow: goto, click,
type, scroll, hover, camera. openPopup and `target: popup` are invalid
without an extension. This is the general "record this web app flow" case:
onboarding walkthroughs, bug reproductions, feature demos.

## Gotchas

- The stage URL must be a real http(s) page the extension has host
  permissions for (or that its popup does not need to touch).
- Popup interactions target `target: popup`; page interactions default to page.
- Completion waits should watch for a working state to appear THEN disappear;
  matching loose words can false-positive on unrelated UI copy.
- Repeated scrapes/automation against the same third-party page can get rate
  limited; vary the target or wait between runs.
- The MCP server (`diorama-mcp`) offers interactive tools (launch_session,
  open_popup, click, screenshot) to explore the extension live before writing
  the sheet.

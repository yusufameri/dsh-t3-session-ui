# Capture assets

> **Two kinds of image live here.** The `live-*.png` files ARE screenshots of a real DeepSeek
> Harness GUI with this plugin installed — real `os.hostname()`, real session `cwd`, real agent
> preset, real approval policy, real token measurement, read through the plugin's own Host route.
> Everything else (`session-context-*`, `context-*`, `status-ladder`, `context-ring`) is a
> **component render**: the plugin's real `client.js` driven by fixture data and painted with a
> representative `--dsw-alias-*` token sheet. Those renders use invented data (`Shima's MacBook
> Pro`, `acme`, `deepseek-v4.1-flash`) and are not screenshots; the live captures supersede them
> wherever the two disagree.

Two more honest caveats: the pages disable CSS animations and transitions so a capture is
deterministic, which means the working-status dot is shown at full opacity rather than mid-pulse; and
the GIF frame durations are nominal, so the timing looks the same on any viewer regardless of how
fast the browser actually paints.

## Live captures

Taken from a real DSH `0.2.0-rc.1` instance booted with an isolated `DSH_HOME` containing only this
plugin, driven over the Chrome DevTools Protocol (`tools/live-cdp.mjs`). The values shown are read
from that instance's own services, so nothing here is fixture data — note `Shimas's MacBook Pro`,
`default-workspace`, `standard` and `ask`, each of which comes from a different Host probe.

| File | Shows | Size |
|---|---|---|
| [`live-app.png`](./live-app.png) | The whole GUI, to show this is a real app window | 1440×757, 58658 B |
| [`live-hover-card.png`](./live-hover-card.png) | The session-row hover card on a real row, carrying real host values | 261×218, 10780 B |
| [`live-composer-panel.png`](./live-composer-panel.png) | The context ring's panel, expanded inline in the real composer | 790×300, 21431 B |

Regenerate (needs a running instance and Chrome on `--remote-debugging-port`):

```sh
DSH_MODULE_RESOLVE=~/.dsh/profiles/web/package.json \
  node tools/live-cdp.mjs out.png --eval "document.querySelector('.t3s-meterButton').click()"
```

## Component renders

| File | Shows | Frame / size |
|---|---|---|
| [`session-context-hover.png`](./session-context-hover.png) | Session-row hover card — dark | 318×319, still, 14017 B |
| [`session-context-hover-light.png`](./session-context-hover-light.png) | Session-row hover card — light | 318×319, still, 17043 B |
| [`context-meter-panel.png`](./context-meter-panel.png) | Context ring, panel open (92% used) | 684×484, still, 20373 B |
| [`session-header-strip.png`](./session-header-strip.png) | Conversation header — context strip and lineage | 904×116, still, 9241 B |
| [`status-ladder.gif`](./status-ladder.gif) | Status ladder | 318×319, 6 frames @ 1100 ms, loop=0, 42100 B |
| [`context-ring.gif`](./context-ring.gif) | Context ring | 254×298, 7 frames @ 700 ms, loop=0, 13603 B |

## How they are produced

`tools/capture.mjs` writes one self-contained HTML page per shot, loads Chrome headless against it,
measures the rendered box with `--dump-dom`, captures a deliberately over-sized window with
`--screenshot`, and crops to the measured box with `tools/imaging.py` (Pillow only — there is no
ffmpeg, ImageMagick, Playwright or Puppeteer in this pipeline). Because the crop is derived from the
measured box, every asset carries the same 16 px of page background around its container, and the
verifier re-checks that padding band on every PNG — a clipped render would show the card's own
background at the edge instead of the page background.

Rendering the components this way exercises the shipped code path:

```js
// what the capture page does, matching the DSH client-module loader
window.__ModuleLoader__ = { load: (def) => { window.__DEF__ = def } }
const mod = window.__DEF__.factory((name) => (name === 'react' ? React : ReactDOM))
mod.apply(fakeCtx)                       // inserts the plugin's real stylesheet
mod.__internals.components.SessionRowHover  // the real component, real props
```

## Regenerating

`node`/`npm` are not on `PATH` on the capture machine, so the harness pins the runtime paths and
accepts `DSH_CAPTURE_CHROME` / `DSH_CAPTURE_PYTHON` overrides. Locally:

```sh
RUNTIME=/Users/yusufameri/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies
PATH="$RUNTIME/node/bin:$PATH" "$RUNTIME/node/bin/node" \
  "$RUNTIME/pnpm/bin/pnpm.mjs" capture
```

The harness is idempotent: it wipes `tools/.capture/`, rebuilds every page and frame, rewrites all
six assets, rewrites this file with fresh dimensions, and then verifies with Pillow. `pnpm capture --
--only <id>` rebuilds one asset.

## Assets

### `session-context-hover.png`

`SessionRowHover` on a fully-populated fixture bundle: the resolved status pill, machine, workspace, dirty branch, model · provider, agent preset, parent session, delegation depth, approval policy and context usage, plus the error line for a failed turn.

- 318×319 px, 14017 bytes, dark theme, 376 distinct colours
- Regenerate: `pnpm capture -- --only hover-dark`

### `session-context-hover-light.png`

The same hover card and fixture rendered against the light token sheet.

- 318×319 px, 17043 bytes, light theme, 583 distinct colours
- Regenerate: `pnpm capture -- --only hover-light`

### `context-meter-panel.png`

`ContextMeter` after a real click on `.t3s-meterButton`, so the internal panel is open: the ring in its overloaded red state, the 92% token bar, the measured-from note, the **Compact** action, and the display toggles it hosts.

- 684×484 px, 20373 bytes, dark theme, 426 distinct colours
- Regenerate: `pnpm capture -- --only meter-panel`

### `session-header-strip.png`

`HeaderContextStrip` (status, model, branch, approval policy, context usage, subagent count) beside `HeaderLineage` (the session title plus parent, preset and depth chips), as the two header seats render them together. The strip is deliberately narrow: the workspace, preset and depth stay in the hover card and the lineage breadcrumb.

- 904×116 px, 9241 bytes, dark theme, 331 distinct colours
- Regenerate: `pnpm capture -- --only header-strip`

### `status-ladder.gif`

`SessionRowHover` cycled through the six rungs the Host can resolve — approval, awaiting input, working, error, subagent monitoring (with `subagents.count`) and ready — one frame each, on a fixed-height card so the block does not jump between frames.

- 6 frames, 318×319 px, 42100 bytes, 1100 ms per frame, `loop=0` (infinite), dark theme
- Frames: approval, input, working, failed, monitoring, ready
- Regenerate: `pnpm capture -- --only status-ladder`

### `context-ring.gif`

`ContextMeter` with the panel closed, at 6%, 28%, 41.5%, 67%, 82%, 92% and 97% of the context window. The ring is brand blue until it crosses the plugin's 90% threshold, then switches to the error colour — the last two frames.

- 7 frames, 254×298 px, 13603 bytes, 700 ms per frame, `loop=0` (infinite), dark theme
- Frames: 6%, 28%, 41.5%, 67%, 82%, 92%, 97%
- Regenerate: `pnpm capture -- --only context-ring`

## Theme token sheet

Representative values, hand-copied — not read from a live DSH install.

| Token | dark | light |
|---|---|---|
| `--dsw-alias-bg-base` | `#0d0d0d` | `#ffffff` |
| `--dsw-alias-bg-layer-1` | `#171717` | `#f7f7f8` |
| `--dsw-alias-bg-layer-2` | `#232323` | `#ececee` |
| `--dsw-alias-bg-overlay` | `#1f1f1f` | `#ffffff` |
| `--dsw-alias-border-l1` | `#2e2e2e` | `#e4e4e7` |
| `--dsw-alias-border-l2` | `#3d3d3d` | `#d4d4d8` |
| `--dsw-alias-brand-primary` | `#4d6bfe` | `#4d6bfe` |
| `--dsw-alias-label-primary` | `#f5f5f5` | `#18181b` |
| `--dsw-alias-label-secondary` | `#a3a3a3` | `#6b7280` |
| `--dsw-alias-state-error-primary` | `#ef4444` | `#dc2626` |
| `--dsw-alias-state-success-primary` | `#22c55e` | `#16a34a` |
| `--dsw-alias-state-warn-primary` | `#f59e0b` | `#d97706` |
| `--dsw-alias-state-idle-primary` | `#6b7280` | `#9ca3af` |
| `--dsw-alias-specific-sidebar-fill` | `#111111` | `#fafafa` |

The container each surface sits in is part of the render: `bg-overlay` for the hover card,
`bg-layer-1` for the composer and header bars, on a `bg-base` page.

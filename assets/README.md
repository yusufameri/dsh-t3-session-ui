# Capture assets

> **These are renders, not screenshots.** Every image here is the plugin's *real* components —
> `client.js` loaded through a stubbed `window.__ModuleLoader__`, its own `apply()` run to inject
> the real stylesheet — driven by fixture data through the plugin's own code path and painted with a
> **representative token sheet** for the `--dsw-alias-*` variables. They are **not screenshots of a
> live DSH window**, the token values were not read from a running DSH install, and nothing here
> proves what a live session looks like. The fixtures use invented data (`Shima's MacBook Pro`,
> `acme`, `deepseek-v4.1-flash`), not a real machine or session.

Two more honest caveats: the pages disable CSS animations and transitions so a capture is
deterministic, which means the working-status dot is shown at full opacity rather than mid-pulse; and
the GIF frame durations are nominal, so the timing looks the same on any viewer regardless of how
fast the browser actually paints.

## Current assets

| File | Shows | Frame / size |
|---|---|---|
| [`session-context-hover.png`](./session-context-hover.png) | Session-row hover card — dark | 318×319, still, 14999 B |
| [`session-context-hover-light.png`](./session-context-hover-light.png) | Session-row hover card — light | 318×319, still, 18117 B |
| [`session-header-strip.png`](./session-header-strip.png) | Conversation header — context strip and lineage | 904×116, still, 9241 B |
| [`status-ladder.gif`](./status-ladder.gif) | Status ladder | 318×319, 6 frames @ 1100 ms, loop=0, 44442 B |
| [`settings-row.png`](./settings-row.png) | Settings row — Session context display preferences | 704×194, still, 12309 B |

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

- 318×319 px, 14999 bytes, dark theme, 377 distinct colours
- Regenerate: `pnpm capture -- --only hover-dark`

### `session-context-hover-light.png`

The same hover card and fixture rendered against the light token sheet.

- 318×319 px, 18117 bytes, light theme, 584 distinct colours
- Regenerate: `pnpm capture -- --only hover-light`

### `session-header-strip.png`

`HeaderContextStrip` (status, model, branch, approval policy, context usage, subagent count) beside `HeaderLineage` (the session title plus parent, preset and depth chips), as the two header seats render them together. The strip is deliberately narrow: the workspace, preset and depth stay in the hover card and the lineage breadcrumb.

- 904×116 px, 9241 bytes, dark theme, 331 distinct colours
- Regenerate: `pnpm capture -- --only header-strip`

### `status-ladder.gif`

`SessionRowHover` cycled through the six rungs the Host can resolve — approval, awaiting input, working, error, subagent monitoring (with `subagents.count`) and ready — one frame each, on a fixed-height card so the block does not jump between frames.

- 6 frames, 318×319 px, 44442 bytes, 1100 ms per frame, `loop=0` (infinite), dark theme
- Frames: approval, input, working, failed, monitoring, ready
- Regenerate: `pnpm capture -- --only status-ladder`

### `settings-row.png`

`SettingsRow`, as DSH renders it in the General section of Settings: one label, a wrapping toggle per fact, and the machine-label override. This is where the plugin keeps its preferences, so nothing of the sort sits in the composer.

- 704×194 px, 12309 bytes, dark theme, 308 distinct colours
- Regenerate: `pnpm capture -- --only settings-row`

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

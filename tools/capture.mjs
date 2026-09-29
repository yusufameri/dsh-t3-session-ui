#!/usr/bin/env node
/**
 * Deterministic screenshot + GIF capture for dsh-t3-session-ui.
 *
 * The plugin's Client half renders React surfaces that normally sit inside a
 * live DSH window. There are no browser-automation packages on this machine
 * (no Playwright, no Puppeteer, no ffmpeg, no ImageMagick), so the pipeline is:
 *
 *   1. write one self-contained HTML page per shot into `tools/.capture/`,
 *   2. load `client.js` in Chrome exactly the way the DSH client-module loader
 *      does — stub `window.__ModuleLoader__`, then call the factory and the
 *      plugin's own `apply()` with a minimal Cordis-shaped context, so the real
 *      stylesheet and the real components are what get rendered,
 *   3. drive each component through its real props with a fixture context
 *      bundle (`test/client.test.js`'s FULL_BUNDLE shape), and
 *   4. capture with `--dump-dom` (to measure the rendered box) then
 *      `--screenshot` (to capture a generous window), and crop to the measured
 *      box with Pillow so every asset gets identical padding.
 *
 * Nothing here imports the plugin's internals directly: `client.js` is loaded
 * as a classic script by the browser, so the plugin keeps working exactly as
 * published. `tools/` is excluded from the npm package.
 *
 * Usage:
 *   node tools/capture.mjs                 # every asset, then verify
 *   node tools/capture.mjs --list           # list shot ids
 *   node tools/capture.mjs --only hover-dark,context-ring
 *   node tools/capture.mjs --skip-verify
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const BUILD = join(HERE, '.capture')
const ASSETS = join(ROOT, 'assets')
const CLIENT = join(ROOT, 'client.js')

// --------------------------------------------------------------- executables

/** Absolute paths this machine needs, since `node`/`npm` are not on PATH. */
const DSH_RUNTIME = '/Users/yusufameri/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies'

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return undefined
}

const CHROME =
  process.env.DSH_CAPTURE_CHROME ??
  firstExisting([
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
  ])

const PYTHON =
  process.env.DSH_CAPTURE_PYTHON ??
  firstExisting([join(DSH_RUNTIME, 'python/bin/python3'), '/usr/bin/python3', '/opt/homebrew/bin/python3'])

if (CHROME === undefined) throw new Error('Google Chrome not found; set DSH_CAPTURE_CHROME')
if (PYTHON === undefined) throw new Error('python3 with Pillow not found; set DSH_CAPTURE_PYTHON')
for (const required of [
  join(ROOT, 'node_modules/react/umd/react.development.js'),
  join(ROOT, 'node_modules/react-dom/umd/react-dom.development.js'),
]) {
  if (!existsSync(required)) throw new Error(`missing UMD build: ${required} (run \`pnpm install\`)`)
}

// -------------------------------------------------------------------- tokens

/**
 * Representative DSH theme tokens.
 *
 * These are NOT read from a live DSH install: they are a hand-copied,
 * representative sheet for the `--dsw-alias-*` variables the plugin's
 * stylesheet consumes. Stated plainly in `assets/README.md` so nobody reads
 * these renders as pixel-exact screenshots of the shipped theme.
 */
const THEMES = {
  dark: {
    'color-scheme': 'dark',
    '--dsw-alias-bg-base': '#0d0d0d',
    '--dsw-alias-bg-layer-1': '#171717',
    '--dsw-alias-bg-layer-2': '#232323',
    '--dsw-alias-bg-overlay': '#1f1f1f',
    '--dsw-alias-border-l1': '#2e2e2e',
    '--dsw-alias-border-l2': '#3d3d3d',
    '--dsw-alias-brand-primary': '#4d6bfe',
    '--dsw-alias-label-primary': '#f5f5f5',
    '--dsw-alias-label-secondary': '#a3a3a3',
    '--dsw-alias-state-error-primary': '#ef4444',
    '--dsw-alias-state-success-primary': '#22c55e',
    '--dsw-alias-state-warn-primary': '#f59e0b',
    '--dsw-alias-state-idle-primary': '#6b7280',
    '--dsw-alias-specific-sidebar-fill': '#111111',
  },
  light: {
    'color-scheme': 'light',
    '--dsw-alias-bg-base': '#ffffff',
    '--dsw-alias-bg-layer-1': '#f7f7f8',
    '--dsw-alias-bg-layer-2': '#ececee',
    '--dsw-alias-bg-overlay': '#ffffff',
    '--dsw-alias-border-l1': '#e4e4e7',
    '--dsw-alias-border-l2': '#d4d4d8',
    '--dsw-alias-brand-primary': '#4d6bfe',
    '--dsw-alias-label-primary': '#18181b',
    '--dsw-alias-label-secondary': '#6b7280',
    '--dsw-alias-state-error-primary': '#dc2626',
    '--dsw-alias-state-success-primary': '#16a34a',
    '--dsw-alias-state-warn-primary': '#d97706',
    '--dsw-alias-state-idle-primary': '#9ca3af',
    '--dsw-alias-specific-sidebar-fill': '#fafafa',
  },
}

// ------------------------------------------------------------------ fixtures

/** The fully-populated bundle shape from `test/client.test.js`, unchanged. */
const FULL_BUNDLE = {
  sessionId: 's1',
  live: true,
  machine: {
    hostname: 'Shimas-MacBook-Pro.local',
    machineLabel: "Shima's MacBook Pro",
    machineLabelIsCustom: false,
    platform: 'darwin',
    arch: 'arm64',
    release: '24.0.0',
    home: '/Users/shima',
    node: 'v24.21.0',
    pluginVersion: '0.1.0',
  },
  cwd: '/Users/shima/projects/acme',
  workspaceName: 'acme',
  git: { branch: 'main', detached: false, dirty: true, root: '/Users/shima/projects/acme', worktree: undefined },
  provider: 'opencode-go',
  model: 'deepseek-v4.1-flash',
  contextWindow: 200000,
  reasoningEffort: 'high',
  preset: 'poteto',
  parentSession: 's0',
  delegationDepth: 1,
  origin: undefined,
  isSeeded: false,
  createdAt: 1,
  seq: 10,
  turn: { phase: 'failed', error: 'boom' },
  approval: { policy: 'ask' },
  subagents: { count: 0 },
  goal: undefined,
  tokens: {
    used: 83000,
    max: 200000,
    usedPercent: 41.5,
    baselineKind: 'usage',
    surfaceDeltaTokens: 0,
    nodeCount: 5,
    logRevision: 10,
  },
}

/** A clone of the full bundle with the resolved status rung set explicitly. */
function bundleWithStatus(kind) {
  const bundle = structuredClone(FULL_BUNDLE)
  bundle.sessionId = 's1'
  bundle.status = { kind }
  bundle.subagents = { count: 0 }
  bundle.turn = { phase: 'idle' }
  if (kind === 'working') {
    bundle.turn = { phase: 'running' }
  }
  if (kind === 'failed') {
    bundle.turn = { phase: 'failed', error: 'provider stream closed: ECONNRESET after 3 retries' }
    bundle.status.error = 'provider stream closed: ECONNRESET after 3 retries'
  }
  if (kind === 'monitoring') {
    bundle.subagents = { count: 3 }
  }
  return bundle
}


// ---------------------------------------------------------------------- css

/** The hover card / row block: an overlay-coloured card, as DSH's hover card is. */
const CARD_CSS = `
  display: inline-block;
  max-width: 352px;
  padding: 14px 16px;
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, .45);
`

/** The composer strip: layer-1, the surface the context ring lives on. */
const COMPOSER_CSS = `
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: flex-end;
  width: 620px;
  height: 420px;
  padding: 14px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
`

/** A settings-page row: full width, layer-1 background, no shadow. */
const SETTINGS_CSS = `
  display: block;
  width: 640px;
  padding: 14px 16px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
`

/** The conversation header bar. */
const HEADER_CSS = `
  display: flex;
  align-items: center;
  width: 840px;
  min-height: 52px;
  padding: 12px 16px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
`

// --------------------------------------------------------------------- shots

const LADDER = ['approval', 'input', 'working', 'failed', 'monitoring', 'ready']

/**
 * Every generated asset.
 *
 * `frames` always holds at least one entry so PNG and GIF shots share one code
 * path. `surfaceCss` styles the visual container the plugin's component sits in
 * (`bg-overlay` for a hover card, `bg-layer-1` for a composer or header bar);
 * the crop adds the page-background padding around it.
 */
const SHOTS = [
  {
    id: 'hover-dark',
    kind: 'png',
    asset: 'session-context-hover.png',
    theme: 'dark',
    label: 'Session-row hover card — dark',
    what:
      '`SessionRowHover` on a fully-populated fixture bundle: the resolved status pill, machine, ' +
      'workspace, dirty branch, model · provider, agent preset, parent session, delegation depth, ' +
      'approval policy and context usage, plus the error line for a failed turn.',
    surfaceCss: CARD_CSS,
    window: { w: 460, h: 420 },
    frames: [
      {
        blocks: [{ component: 'SessionRowHover', props: { sessionId: 's1' } }],
        fixtures: { s1: structuredClone(FULL_BUNDLE) },
      },
    ],
  },
  {
    id: 'hover-light',
    kind: 'png',
    asset: 'session-context-hover-light.png',
    theme: 'light',
    label: 'Session-row hover card — light',
    what: 'The same hover card and fixture rendered against the light token sheet.',
    surfaceCss: CARD_CSS,
    window: { w: 460, h: 420 },
    frames: [
      {
        blocks: [{ component: 'SessionRowHover', props: { sessionId: 's1' } }],
        fixtures: { s1: structuredClone(FULL_BUNDLE) },
      },
    ],
  },
  {
    id: 'header-strip',
    kind: 'png',
    asset: 'session-header-strip.png',
    theme: 'dark',
    label: 'Conversation header — context strip and lineage',
    what:
      '`HeaderContextStrip` (status, model, branch, approval policy, context usage, subagent count) ' +
      'beside `HeaderLineage` (the session title plus parent, preset and depth chips), as the two ' +
      'header seats render them together. The strip is deliberately narrow: the workspace, preset ' +
      'and depth stay in the hover card and the lineage breadcrumb.',
    surfaceCss: HEADER_CSS,
    contentCss: 'display: flex; align-items: center; justify-content: space-between; gap: 24px; width: 100%;',
    window: { w: 1000, h: 240 },
    frames: [
      {
        blocks: [
          {
            component: 'HeaderLineage',
            props: {
              lineageSessionId: 's1',
              displayTitle: "Port T3 Code's session-context surfaces",
              openTitle: '@function',
            },
          },
          { component: 'HeaderContextStrip', props: { sessionId: 's1' } },
        ],
        fixtures: { s1: { ...structuredClone(FULL_BUNDLE), status: { kind: 'ready' }, turn: { phase: 'idle' }, subagents: { count: 2 } } },
      },
    ],
  },
  {
    id: 'status-ladder',
    kind: 'gif',
    asset: 'status-ladder.gif',
    theme: 'dark',
    label: 'Status ladder',
    what:
      '`SessionRowHover` cycled through the six rungs the Host can resolve — approval, awaiting ' +
      'input, working, error, subagent monitoring (with `subagents.count`) and ready — one frame ' +
      'each, on a fixed-height card so the block does not jump between frames.',
    surfaceCss: CARD_CSS,
    durationMs: 1100,
    window: { w: 460, h: 460 },
    maxBytes: 1500000,
    frames: LADDER.map((kind) => ({
      label: kind,
      blocks: [{ component: 'SessionRowHover', props: { sessionId: 's1' } }],
      fixtures: { s1: bundleWithStatus(kind) },
    })),
  },
  {
    id: 'settings-row',
    kind: 'png',
    asset: 'settings-row.png',
    theme: 'dark',
    label: 'Settings row — Session context display preferences',
    what:
      '`SettingsRow`, as DSH renders it in the General section of Settings: one label, a ' +
      'wrapping toggle per fact, and the machine-label override. This is where the plugin keeps ' +
      'its preferences, so nothing of the sort sits in the composer.',
    surfaceCss: SETTINGS_CSS,
    contentCss: 'display: block; width: 100%;',
    prefs: true,
    window: { w: 780, h: 320 },
    // No session data: the settings row renders from preferences alone.
    frames: [{ blocks: [{ component: 'SettingsRow', props: {} }], fixtures: {} }],
  },
]

// ----------------------------------------------------------------- page text

/**
 * Script that runs inside the page, after `client.js` has registered itself.
 *
 * It performs the same three steps a DSH window performs — build the module
 * from the loader definition, run the plugin's own `apply()` so the real
 * stylesheet is inserted through the plugin's real code path, then mount the
 * component with a translator, a store and fixture data. No backticks or `${`
 * may appear below: this string is itself a template literal.
 */
const PAGE_SCRIPT = `
(function () {
  // Any failure surfaces in the title, which the harness reads back, so a
  // broken page reports why instead of just timing out.
  function fail(prefix, error) {
    var message = error && error.message ? error.message : String(error);
    document.title = prefix + ' ' + message.replace(/\\s+/g, ' ').slice(0, 300);
  }
  window.addEventListener('error', function (event) {
    var detail = event.error || event.message;
    if (!detail && event.target && event.target.src) detail = 'failed to load ' + event.target.src;
    fail('ERROR', detail || 'unknown error event');
  });
  try {
  var spec = JSON.parse(document.getElementById('capture-spec').textContent);

  function unexpected(name) {
    throw new Error('client.js asked for an unexpected module: ' + name);
  }
  var mod = window.__DEF__.factory(function (name) {
    if (name === 'react') return React;
    if (name === 'react-dom') return ReactDOM;
    return unexpected(name);
  });

  var internals = mod.__internals;
  var en = internals.dictionaries.en;
  function t(key, values) {
    var template = Object.prototype.hasOwnProperty.call(en, key) ? en[key] : key;
    return values === undefined ? template : internals.fill(template, values);
  }

  // The plugin's real apply(): registers dictionaries and injects the real
  // stylesheet, so the captured surfaces carry the real CSS.
  mod.apply({
    effect: function (fn) { return fn(); },
    on: function () { return function () {}; },
    locale: {
      register: function () { return function () {}; },
      bind: function () { return t; },
    },
    slots: {
      inject: function (key, callback) { return callback(); },
      register: function () { return function () {}; },
    },
  });

  // A stub of the shared context store, returning the SAME entry object for a
  // session id on every read (useSyncExternalStore compares by identity).
  var entries = Object.create(null);
  Object.keys(spec.fixtures).forEach(function (id) {
    entries[id] = { at: 0, pending: false, value: spec.fixtures[id], error: undefined };
  });
  var store = {
    subscribe: function () { return function () {}; },
    peek: function (id) { return entries[id]; },
    load: function () { return Promise.resolve(); },
    refreshAll: function () {},
  };
  var prefs = spec.prefs ? internals.createPrefsStore() : undefined;

  var blocks = spec.blocks.map(function (block) {
    var Component = internals.components[block.component];
    if (Component === undefined) throw new Error('unknown component: ' + block.component);
    var props = Object.assign({}, block.props, { t: t, store: store, prefs: prefs });
    // JSON cannot carry a callback, so a spec marks a prop as a function and
    // the page supplies a no-op one (HeaderLineage's openTitle is the only one).
    Object.keys(props).forEach(function (key) {
      if (props[key] === '@function') props[key] = function () {};
    });
    return React.createElement(Component, props);
  });

  var content = document.getElementById('content');
  ReactDOM.createRoot(content).render(
    blocks.length === 1 ? blocks[0] : React.createElement(React.Fragment, null, blocks),
  );

  function unionRect() {
    var surface = document.getElementById('surface');
    var nodes = [content].concat(Array.prototype.slice.call(surface.querySelectorAll('*')));
    var left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    nodes.forEach(function (node) {
      var rect = node.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    });
    return { left: left, top: top, right: right, bottom: bottom };
  }

  function report() {
    var surface = document.getElementById('surface').getBoundingClientRect();
    var contentRect = unionRect();
    var scroller = document.scrollingElement || document.documentElement;
    document.title = 'META ' + [
      surface.left, surface.top, surface.width, surface.height,
      contentRect.left, contentRect.top, contentRect.right, contentRect.bottom,
      scroller.scrollWidth, scroller.scrollHeight,
    ].join(',');
  }

  // Nothing to click: measure and report. A per-shot afterMount hook could
  // drive an interaction here before reporting.
  setTimeout(report, 140);
  } catch (error) {
    fail('THROWN', error);
  }
})();
`

/** Render one shot's page HTML. */
function pageHtml(shot, frame, surfaceCss) {
  const theme = THEMES[shot.theme]
  const tokens = Object.entries(theme)
    .map(([name, value]) => `${name}:${value};`)
    .join('')
  const spec = JSON.stringify({
    blocks: frame.blocks,
    fixtures: frame.fixtures,
    prefs: shot.prefs === true,
    afterMount: shot.afterMount ?? null,
  }).replace(/<\//g, '<\\/')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>capture</title>
<style>
:root { ${tokens} }
*, *::before, *::after { box-sizing: border-box; animation: none !important; transition: none !important; }
html, body { margin: 0; padding: 0; }
body {
  /* Wide slack so the crop band is guaranteed to be untouched page background.
     A 16px band was too tight: the card's soft drop shadow still tinted it, so
     the verifier's flat-border check failed on the light theme (where the card
     and the page are both near-white and the shadow is the only separation). */
  padding: 48px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  font-size: 12px;
  line-height: 1.35;
  -webkit-font-smoothing: antialiased;
}
/* The visual container the surface sits in: bg-overlay for a hover card,
   bg-layer-1 for a composer or header bar. The crop frames exactly this box. */
#surface { ${surfaceCss} }
#content { ${shot.contentCss ?? 'display: flex; align-items: center;'} }
</style>
</head>
<body>
<div id="surface"><div id="content"></div></div>
<!-- React 18 UMD builds, exactly as a DSH window ships them to a client plugin. -->
<script src="${pathToFileURL(join(ROOT, 'node_modules/react/umd/react.development.js')).href}"></script>
<script src="${pathToFileURL(join(ROOT, 'node_modules/react-dom/umd/react-dom.development.js')).href}"></script>
<script>window.__ModuleLoader__ = { load: function (definition) { window.__DEF__ = definition; } };</script>
<script src="${pathToFileURL(CLIENT).href}"></script>
<script id="capture-spec" type="application/json">${spec}</script>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`
}

// ------------------------------------------------------------------- chrome

const CHROME_PROFILE = join(BUILD, 'chrome-profile')

function chromeArgs({ url, window, profile, screenshot, dumpDom }) {
  const args = [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--window-size=${window.w},${window.h}`,
    '--virtual-time-budget=4000',
  ]
  if (dumpDom) args.push('--dump-dom')
  if (screenshot) args.push(`--screenshot=${screenshot}`)
  args.push(url)
  return args
}

/** Run Chrome in an isolated profile, and reap it as soon as its artifact lands. */
function chromeRun({ url, window: windowSize, screenshot: shotPath, dumpDom }) {
  const args = chromeArgs({
    url,
    window: windowSize,
    profile: CHROME_PROFILE,
    screenshot: shotPath,
    dumpDom,
  })
  if (shotPath !== undefined) rmSync(shotPath, { force: true })

  return new Promise((resolve, reject) => {
    // `detached` puts Chrome in its own process group so the whole tree
    // (browser, renderers, GPU, updater helpers) can be reaped in one signal.
    const child = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let stdout = ''
    let stderr = ''
    let done = false
    let lastSize = -1

    const reap = () => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }

    const finish = (error, value) => {
      if (done) return
      done = true
      clearTimeout(deadline)
      clearInterval(poller)
      reap()
      if (error) reject(error)
      else resolve(value)
    }

    const deadline = setTimeout(
      () => finish(new Error(`Chrome timed out.\nargs: ${args.join(' ')}\nstderr tail:\n${stderr.slice(-2000)}`)),
      45000,
    )

    // This Chrome build writes its artifact and then never exits (the updater
    // helper lingers), so completion is defined by the artifact, not by exit.
    const artifactReady = () => {
      if (dumpDom) return /<title>(?:META [-\d.,]+|ERROR [^<]*|THROWN [^<]*)<\/title>/.test(stdout)
      if (shotPath === undefined) return false
      if (!existsSync(shotPath)) return false
      const size = statSync(shotPath).size
      // Wait for the size to settle so a partially-written PNG is never read.
      if (size > 0 && size === lastSize) return true
      lastSize = size
      return false
    }

    const poller = setInterval(() => {
      if (!done && artifactReady()) finish(null, stdout)
    }, 60)

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => finish(error))
    child.on('exit', () => {
      // A prompt exit is fine too, as long as its artifact landed.
      if (done) return
      if (artifactReady()) finish(null, stdout)
      else finish(new Error(`Chrome exited without producing its artifact.\nstderr tail:\n${stderr.slice(-2000)}`))
    })
  })
}

/** Measure the rendered surface and its painted content in one page load. */
async function measure(pagePath, windowSize) {
  const dom = await chromeRun({ url: pathToFileURL(pagePath).href, window: windowSize, dumpDom: true })
  const failure = /<title>((?:ERROR|THROWN)[^<]*)<\/title>/.exec(dom)
  if (failure !== null) {
    throw new Error(`${pagePath} failed to mount: ${failure[1]}`)
  }
  const match = /<title>META ([^<]+)<\/title>/.exec(dom)
  if (match === null) {
    throw new Error(`no measurement reported by ${pagePath}; the page did not finish mounting`)
  }
  const [sx, sy, sw, sh, cx, cy, cr, cb, scrollW, scrollH] = match[1].split(',').map(Number)
  return {
    surface: { x: sx, y: sy, w: sw, h: sh },
    content: { left: cx, top: cy, right: cr, bottom: cb },
    scroll: { w: scrollW, h: scrollH },
  }
}

/** Capture a generous window to a raw PNG. */
async function screenshot(pagePath, windowSize, outPath) {
  await chromeRun({ url: pathToFileURL(pagePath).href, window: windowSize, screenshot: outPath })
  if (!existsSync(outPath)) throw new Error(`Chrome wrote no screenshot to ${outPath}`)
  return outPath
}

function python(args, { quiet = false } = {}) {
  const result = spawnSync(PYTHON, [join(HERE, 'imaging.py'), ...args], {
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`imaging.py ${args[0]} failed (exit ${result.status})\n${result.stderr ?? ''}`)
  }
  return result.stdout ?? ''
}

// --------------------------------------------------------------------- crop

const CROP_PADDING = 32

/** Crop box = the union of every frame's surface, plus identical padding. */
function unionCropBoxes(boxes) {
  const left = Math.floor(Math.min(...boxes.map((box) => box.surface.x)) - CROP_PADDING)
  const top = Math.floor(Math.min(...boxes.map((box) => box.surface.y)) - CROP_PADDING)
  const right = Math.ceil(Math.max(...boxes.map((box) => box.surface.x + box.surface.w)) + CROP_PADDING)
  const bottom = Math.ceil(Math.max(...boxes.map((box) => box.surface.y + box.surface.h)) + CROP_PADDING)
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/** Assert the painted content really is inside the container that frames it. */
function assertContained(shot, frame, measurement) {
  const { surface, content } = measurement
  const slack = 1
  const fits =
    content.left >= surface.x - slack &&
    content.top >= surface.y - slack &&
    content.right <= surface.x + surface.w + slack &&
    content.bottom <= surface.y + surface.h + slack
  if (!fits) {
    const describe = (rect) => Object.values(rect).map((value) => Math.round(value)).join(',')
    throw new Error(
      `${shot.id}/${frame.label ?? 'frame'}: the rendered content overflows its container ` +
        `(surface ${describe(surface)} vs content ${Math.round(content.left)},${Math.round(content.top)},` +
        `${Math.round(content.right)},${Math.round(content.bottom)}). Increase the surface box.`,
    )
  }
  const inWindow = surface.x >= CROP_PADDING && surface.y >= CROP_PADDING
  if (!inWindow) {
    throw new Error(`${shot.id}: the surface sits closer than the crop padding to the window edge`)
  }
}

// --------------------------------------------------------------------- main

function parseArgs(argv) {
  const options = { only: undefined, verify: true }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--list') options.list = true
    else if (arg === '--only') options.only = (argv[++index] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (arg === '--skip-verify') options.verify = false
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

/** Build every frame page for a shot, measure it, and screenshot it. */
async function captureShot(shot) {
  const selected = shot.frames
  const pages = []

  const buildPass = async (heights) => {
    const built = []
    for (const [index, frame] of selected.entries()) {
      const height = heights?.[index]
      const surfaceCss = height === undefined ? shot.surfaceCss : `${shot.surfaceCss}\n  height: ${height}px;`
      const pagePath = join(BUILD, `${shot.id}-${index}.html`)
      writeFileSync(pagePath, pageHtml(shot, frame, surfaceCss), 'utf8')
      const measurement = await measure(pagePath, shot.window)
      assertContained(shot, frame, measurement)
      built.push({ frame, index, pagePath, measurement })
    }
    return built
  }

  // Pass 1: natural geometry, so a GIF can pin every frame to one height and
  // the block does not resize between frames.
  const natural = await buildPass(undefined)
  if (shot.kind === 'gif') {
    const heights = natural.map((entry) => entry.measurement.surface.h)
    const pinned = Math.max(...heights)
    pages.push(...(await buildPass(heights.map(() => pinned))))
  } else {
    pages.push(...natural)
  }

  // Screenshot every frame from a generous window.
  const raw = []
  for (const entry of pages) {
    const out = join(BUILD, `${shot.id}-${entry.index}.raw.png`)
    await screenshot(entry.pagePath, shot.window, out)
    raw.push({ ...entry, raw: out })
  }

  const cropBox = unionCropBoxes(raw.map((entry) => entry.measurement))
  if (shot.kind === 'png') {
    const output = join(ASSETS, shot.asset)
    python(['crop', '--input', raw[0].raw, '--output', output, '--box', `${cropBox.x},${cropBox.y},${cropBox.w},${cropBox.h}`])
    return { output, cropBox, page: raw[0].pagePath, frames: [output] }
  }

  const framePaths = raw.map((entry) => {
    const out = join(BUILD, `${shot.id}-${entry.index}.png`)
    python(['crop', '--input', entry.raw, '--output', out, '--box', `${cropBox.x},${cropBox.y},${cropBox.w},${cropBox.h}`])
    return out
  })
  const output = join(ASSETS, shot.asset)
  python([
    'gif',
    '--output', output,
    '--frames', ...framePaths,
    '--duration', String(shot.durationMs),
    '--colors', '128',
    '--background', THEMES[shot.theme]['--dsw-alias-bg-base'],
  ])
  return { output, cropBox, page: raw[0].pagePath, frames: framePaths }
}

/** Short, copy-pasteable command that regenerates exactly this asset. */
const regen = (id) => `pnpm capture -- --only ${id}`

function writeAssetsReadme(results) {
  const lines = []
  lines.push('# Capture assets')
  lines.push('')
  lines.push(
    '> **These are renders, not screenshots.** Every image here is the plugin\'s *real* components —',
  )
  lines.push(
    '> `client.js` loaded through a stubbed `window.__ModuleLoader__`, its own `apply()` run to inject',
  )
  lines.push(
    '> the real stylesheet — driven by fixture data through the plugin\'s own code path and painted with a',
  )
  lines.push(
    '> **representative token sheet** for the `--dsw-alias-*` variables. They are **not screenshots of a',
  )
  lines.push(
    '> live DSH window**, the token values were not read from a running DSH install, and nothing here',
  )
  lines.push(
    '> proves what a live session looks like. The fixtures use invented data (`Shima\'s MacBook Pro`,',
  )
  lines.push('> `acme`, `deepseek-v4.1-flash`), not a real machine or session.')
  lines.push('')
  lines.push(
    'Two more honest caveats: the pages disable CSS animations and transitions so a capture is',
  )
  lines.push(
    'deterministic, which means the working-status dot is shown at full opacity rather than mid-pulse; and',
  )
  lines.push(
    'the GIF frame durations are nominal, so the timing looks the same on any viewer regardless of how',
  )
  lines.push('fast the browser actually paints.')
  lines.push('')
  lines.push('## Current assets')
  lines.push('')
  lines.push('| File | Shows | Frame / size |')
  lines.push('|---|---|---|')
  for (const { shot, result, report } of results) {
    const [width, height] = report.dimensions
    const frames = shot.kind === 'gif'
      ? `${report.checks.frames} frames @ ${shot.durationMs} ms, loop=0`
      : 'still'
    lines.push(
      `| [\`${shot.asset}\`](./${shot.asset}) | ${shot.label} | ${width}×${height}, ${frames}, ${report.bytes} B |`,
    )
  }
  lines.push('')
  lines.push('## How they are produced')
  lines.push('')
  lines.push(
    '`tools/capture.mjs` writes one self-contained HTML page per shot, loads Chrome headless against it,',
  )
  lines.push(
    'measures the rendered box with `--dump-dom`, captures a deliberately over-sized window with',
  )
  lines.push(
    '`--screenshot`, and crops to the measured box with `tools/imaging.py` (Pillow only — there is no',
  )
  lines.push(
    'ffmpeg, ImageMagick, Playwright or Puppeteer in this pipeline). Because the crop is derived from the',
  )
  lines.push(
    'measured box, every asset carries the same 16 px of page background around its container, and the',
  )
  lines.push(
    'verifier re-checks that padding band on every PNG — a clipped render would show the card\'s own',
  )
  lines.push('background at the edge instead of the page background.')
  lines.push('')
  lines.push('Rendering the components this way exercises the shipped code path:')
  lines.push('')
  lines.push('```js')
  lines.push("// what the capture page does, matching the DSH client-module loader")
  lines.push("window.__ModuleLoader__ = { load: (def) => { window.__DEF__ = def } }")
  lines.push("const mod = window.__DEF__.factory((name) => (name === 'react' ? React : ReactDOM))")
  lines.push("mod.apply(fakeCtx)                       // inserts the plugin's real stylesheet")
  lines.push('mod.__internals.components.SessionRowHover  // the real component, real props')
  lines.push('```')
  lines.push('')
  lines.push('## Regenerating')
  lines.push('')
  lines.push('`node`/`npm` are not on `PATH` on the capture machine, so the harness pins the runtime paths and')
  lines.push('accepts `DSH_CAPTURE_CHROME` / `DSH_CAPTURE_PYTHON` overrides. Locally:')
  lines.push('')
  lines.push('```sh')
  lines.push('RUNTIME=/Users/yusufameri/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies')
  lines.push('PATH="$RUNTIME/node/bin:$PATH" "$RUNTIME/node/bin/node" \\')
  lines.push('  "$RUNTIME/pnpm/bin/pnpm.mjs" capture')
  lines.push('```')
  lines.push('')
  lines.push('The harness is idempotent: it wipes `tools/.capture/`, rebuilds every page and frame, rewrites all')
  lines.push('six assets, rewrites this file with fresh dimensions, and then verifies with Pillow. `pnpm capture --')
  lines.push('--only <id>` rebuilds one asset.')
  lines.push('')
  lines.push('## Assets')
  lines.push('')
  for (const { shot, result, report } of results) {
    const [width, height] = report.dimensions
    lines.push(`### \`${shot.asset}\``)
    lines.push('')
    lines.push(shot.what)
    lines.push('')
    if (shot.kind === 'gif') {
      lines.push(
        `- ${report.checks.frames} frames, ${width}×${height} px, ${report.bytes} bytes, ` +
          `${shot.durationMs} ms per frame, \`loop=0\` (infinite), ${shot.theme} theme`,
      )
      lines.push(`- Frames: ${shot.frames.map((frame) => frame.label).join(', ')}`)
    } else {
      lines.push(`- ${width}×${height} px, ${report.bytes} bytes, ${shot.theme} theme, ${report.checks.distinct_colors} distinct colours`)
    }
    lines.push(`- Regenerate: \`${regen(shot.id)}\``)
    lines.push('')
  }
  lines.push('## Theme token sheet')
  lines.push('')
  lines.push('Representative values, hand-copied — not read from a live DSH install.')
  lines.push('')
  lines.push('| Token | dark | light |')
  lines.push('|---|---|---|')
  for (const name of Object.keys(THEMES.dark)) {
    if (name === 'color-scheme') continue
    lines.push(`| \`${name}\` | \`${THEMES.dark[name]}\` | \`${THEMES.light[name]}\` |`)
  }
  lines.push('')
  lines.push('The container each surface sits in is part of the render: `bg-overlay` for the hover card,')
  lines.push('`bg-layer-1` for the composer and header bars, on a `bg-base` page.')
  lines.push('')
  return lines.join('\n')
}

function main() {
  return mainAsync()
}

async function mainAsync() {
  const options = parseArgs(process.argv.slice(2))
  if (options.list) {
    for (const shot of SHOTS) console.log(`${shot.id}\t${shot.kind}\t${shot.asset}`)
    return 0
  }

  const selected = options.only === undefined ? SHOTS : SHOTS.filter((shot) => options.only.includes(shot.id))
  if (selected.length === 0) throw new Error(`no shots matched --only ${options.only.join(',')}`)
  const unknown = (options.only ?? []).filter((id) => !SHOTS.some((shot) => shot.id === id))
  if (unknown.length > 0) throw new Error(`unknown shot id(s): ${unknown.join(', ')}`)

  rmSync(BUILD, { recursive: true, force: true })
  mkdirSync(BUILD, { recursive: true })
  mkdirSync(ASSETS, { recursive: true })

  console.log(`chrome  ${CHROME}`)
  console.log(`python  ${PYTHON}`)
  console.log(`assets  ${ASSETS}`)
  console.log('')

  const results = []
  for (const shot of selected) {
    const result = await captureShot(shot)
    const report = {
      dimensions: [0, 0],
      bytes: statSync(result.output).size,
      checks: { frames: shot.frames.length, distinct_colors: 0 },
    }
    results.push({ shot, result, report })
    console.log(`built   ${shot.asset}  crop ${result.cropBox.w}x${result.cropBox.h}  ${report.bytes} B`)
  }

  if (!options.verify) return 0

  // Verify every asset currently on disk, not only the ones just rebuilt, so a
  // partial `--only` run still checks the whole README image set.
  const manifest = {
    assets: SHOTS.map((shot) => {
      const path = join(ASSETS, shot.asset)
      if (!existsSync(path)) throw new Error(`missing asset ${path}; run the full capture`)
      const expect =
        shot.kind === 'png'
          ? {
              background: THEMES[shot.theme]['--dsw-alias-bg-base'],
              min_distinct_colors: 24,
              min_luminance_stddev: 3,
              min_content_fraction: 0.02,
              border_tolerance: 6,
            }
          : { frames: shot.frames.length, duration_ms: shot.durationMs, min_distinct_colors: 16 }
      return { path, kind: shot.kind, label: shot.label, expect, max_bytes: shot.maxBytes }
    }),
  }
  const manifestPath = join(BUILD, 'manifest.json')
  const reportPath = join(BUILD, 'verify.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  const output = python(['verify', '--manifest', manifestPath, '--out', reportPath])
  process.stdout.write(output)

  const verified = JSON.parse(readFileSync(reportPath, 'utf8'))
  const byPath = new Map(verified.assets.map((entry) => [entry.path, entry]))
  for (const entry of results) {
    const report = byPath.get(entry.result.output)
    if (report === undefined) throw new Error(`no verification for ${entry.result.output}`)
    entry.report = report
  }

  if (options.only === undefined) {
    writeFileSync(join(ASSETS, 'README.md'), writeAssetsReadme(results), 'utf8')
    console.log(`\nwrote   ${join(ASSETS, 'README.md')}`)
  } else {
    console.log('\npartial run (--only): assets/README.md left untouched')
  }
  console.log('ok')
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error)
    process.exitCode = 1
  },
)

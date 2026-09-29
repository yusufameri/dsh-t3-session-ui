/**
 * Client-half tests.
 *
 * The Client half is a browser module: it registers itself with
 * `window.__ModuleLoader__` and renders React surfaces. These tests stub that
 * loader and the DOM, then render every surface to static markup against a
 * fixture context bundle, so the information hierarchy, the status ladder, and
 * the seat registrations are all checked without a browser.
 *
 * Run with: node --test test/
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

// --- module loader stub -----------------------------------------------------

/** The registration this module hands to `window.__ModuleLoader__`. */
let definition

globalThis.window = {
  __ModuleLoader__: {
    load: (value) => {
      definition = value
    },
  },
  setInterval: () => 0,
  clearInterval: () => {},
}

/** Minimal DOM stub: the Client half inserts one stylesheet at apply time. */
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild() {} },
}

// Node 24 exposes `navigator` as a getter-only global, so define over it.
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
})

await import('../client.js')

assert.equal(definition.id, 'dsh-t3-session-ui', 'module id must match the package name')

const mod = definition.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require("${id}")`)
})

const {
  components,
  createContextStore,
  makeMenuItems,
  resolveStatus,
  normalizePrefs,
  formatTokens,
  formatPercent,
  basename,
  fill,
} = mod.__internals

const EN = mod.__internals.dictionaries.en

/** Build a translator over the plugin's own English dictionary. */
function translator() {
  return (key, values) => {
    const template = Object.prototype.hasOwnProperty.call(EN, key) ? EN[key] : key
    return values === undefined ? template : fill(template, values)
  }
}

const t = translator()

// --- fixtures ---------------------------------------------------------------

/** A fully-populated bundle, as the Host half would return it. */
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

/** A bundle for a session the Host could not see live. */
const OFFLINE_BUNDLE = {
  sessionId: 's2',
  live: false,
  machine: { hostname: 'h', machineLabel: 'h', machineLabelIsCustom: false, node: 'v24', pluginVersion: '0.1.0' },
}

/**
 * Build a shared store pre-populated with one bundle, without touching the
 * network.
 *
 * @param sessionId - Session key to seed.
 * @param bundle - Bundle the stub fetch resolves to.
 * @returns the seeded store.
 */
async function seededStore(sessionId, bundle) {
  const ctx = { effect: (fn) => fn(), on: () => () => {} }
  const store = createContextStore(ctx)
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, value: bundle }),
  })
  await store.load(sessionId, true)
  return store
}

/** Render one surface to static markup. */
function render(Component, props) {
  return renderToStaticMarkup(React.createElement(Component, props))
}

// --- pure helpers -----------------------------------------------------------

describe('formatTokens', () => {
  it('prints exact counts below one thousand', () => {
    assert.equal(formatTokens(999), '999')
  })

  it('uses one decimal for small thousands and rounds larger ones', () => {
    assert.equal(formatTokens(8300), '8.3k')
    assert.equal(formatTokens(83000), '83k')
  })

  it('uses millions above a million', () => {
    assert.equal(formatTokens(1_500_000), '1.5M')
  })

  it('returns a dash for a non-number', () => {
    assert.equal(formatTokens(undefined), '—')
    assert.equal(formatTokens(Number.NaN), '—')
  })
})

describe('formatPercent', () => {
  it('keeps one decimal below ten percent', () => {
    assert.equal(formatPercent(4.25), '4.3%')
  })

  it('rounds to whole percent above ten', () => {
    assert.equal(formatPercent(41.5), '42%')
  })

  it('returns null for a non-number, so the caller can fall back to tokens', () => {
    assert.equal(formatPercent(undefined), null)
  })
})

describe('basename', () => {
  it('returns the trailing segment', () => {
    assert.equal(basename('/Users/shima/projects/acme'), 'acme')
  })

  it('ignores a trailing slash', () => {
    assert.equal(basename('/Users/shima/projects/acme/'), 'acme')
  })

  it('returns undefined for an empty path', () => {
    assert.equal(basename(''), undefined)
    assert.equal(basename(undefined), undefined)
  })
})

describe('resolveStatus', () => {
  it('reports working while a turn runs', () => {
    assert.equal(resolveStatus({ live: true, turn: { phase: 'running' } }, t).tone, 'working')
  })

  it('reports failure with the error detail', () => {
    const status = resolveStatus({ live: true, turn: { phase: 'failed', error: 'boom' } }, t)
    assert.equal(status.tone, 'failed')
    assert.equal(status.detail, 'boom')
  })

  it('reports subagent fan-out when the turn is idle', () => {
    const status = resolveStatus({ live: true, turn: { phase: 'idle' }, subagents: { count: 3 } }, t)
    assert.equal(status.tone, 'monitoring')
    assert.equal(status.label, '3 subagents')
  })

  it('singularises one subagent', () => {
    assert.equal(resolveStatus({ live: true, subagents: { count: 1 } }, t).label, '1 subagent')
  })

  it('lets a running turn outrank subagent fan-out', () => {
    const status = resolveStatus({ live: true, turn: { phase: 'running' }, subagents: { count: 3 } }, t)
    assert.equal(status.tone, 'working')
  })

  it('reports ready for an idle session', () => {
    assert.equal(resolveStatus({ live: true, turn: { phase: 'idle' } }, t).tone, 'ready')
  })

  it('reports offline for a session the Host cannot see', () => {
    assert.equal(resolveStatus({ live: false }, t).tone, 'idle')
  })
})

// --- seat registrations -----------------------------------------------------

describe('apply', () => {
  it('registers all eight surfaces against the agreed seats', () => {
    const registered = []
    const ctx = {
      effect: (fn) => fn(),
      on: () => () => {},
      locale: { register: () => () => {}, bind: () => t },
      slots: {
        inject: (_key, callback) => callback(),
        register: (descriptor, Component) => {
          registered.push({ descriptor, Component })
          return () => {}
        },
      },
    }
    mod.apply(ctx)
    const byName = new Map(registered.map((entry) => [entry.descriptor.name, entry.descriptor]))
    assert.deepEqual(
      [...byName.keys()].sort(),
      [
        'conversation.session.header.actions',
        'conversation.session.header.lineage',
        'conversation.session.header.utilities',
        'settings.general.item',
        'sidebar.session.row.hover',
        'sidebar.session.row.leading',
        'sidebar.workspaces.session.menu.item',
        'sidebar.workspaces.session.row.action',
      ].sort(),
    )
    assert.equal(byName.get('sidebar.session.row.hover').id, 't3s-hover')
    assert.equal(byName.get('sidebar.workspaces.session.row.action').id, 't3s-row-copy')
    // The composer keeps no plugin surface: the meter was taken out entirely.
    assert.equal(byName.has('conversation.input.activity'), false)
    assert.equal(byName.get('settings.general.item').id, 't3-session-ui')
    // The lineage seat is a documented replacement, so it shadows at -1.
    assert.equal(byName.get('conversation.session.header.lineage').priority, -1)
    assert.equal(registered.length, 8)
  })
})

// --- rendered surfaces ------------------------------------------------------

describe('SessionRowHover', () => {
  it('renders the T3 context block from a full bundle', async () => {
    const store = await seededStore('s1', FULL_BUNDLE)
    const html = render(components.SessionRowHover, { sessionId: 's1', store, t })
    // Static markup escapes the apostrophe, so assert on the escaped form.
    assert.match(html, /Shima&#x27;s MacBook Pro/)
    assert.match(html, /acme/)
    assert.match(html, /main \(uncommitted changes\)/)
    assert.match(html, /deepseek-v4\.1-flash · opencode-go/)
    assert.match(html, /poteto/)
    assert.match(html, /s0/)
    assert.match(html, /ask/)
    assert.match(html, /42%/)
    assert.match(html, /Error occurred/)
    assert.match(html, /Error/)
  })

  it('renders the offline line instead of facts for a non-live session', async () => {
    const store = await seededStore('s2', OFFLINE_BUNDLE)
    const html = render(components.SessionRowHover, { sessionId: 's2', store, t })
    assert.match(html, /Not running in this process/)
  })

  it('renders nothing before the first fetch resolves', () => {
    const store = createContextStore({ effect: (fn) => fn(), on: () => () => {} })
    assert.equal(render(components.SessionRowHover, { sessionId: 's9', store, t }), '')
  })

  it('renders nothing without a session id', async () => {
    const store = await seededStore('s1', FULL_BUNDLE)
    assert.equal(render(components.SessionRowHover, { store, t }), '')
  })

  it('omits the workspace and branch rows for a bundle without them', async () => {
    const bare = { sessionId: 's3', live: true, turn: { phase: 'idle' } }
    const store = await seededStore('s3', bare)
    const html = render(components.SessionRowHover, { sessionId: 's3', store, t })
    assert.doesNotMatch(html, /Branch/)
    assert.match(html, /Ready/)
  })
})

describe('SessionRowLeading', () => {
  it('shows the model as the row chip', async () => {
    const store = await seededStore('s1', FULL_BUNDLE)
    const html = render(components.SessionRowLeading, { sessionId: 's1', store, t })
    assert.match(html, /deepseek-v4\.1-flash/)
  })

  it('falls back to a bare status dot when no model is known', async () => {
    const store = await seededStore('s3', { sessionId: 's3', live: true, turn: { phase: 'idle' } })
    const html = render(components.SessionRowLeading, { sessionId: 's3', store, t })
    assert.doesNotMatch(html, /t3s-chipLabel/)
    assert.match(html, /t3s-dot-ready/)
  })
})

describe('HeaderContextStrip', () => {
  it('renders status, model, branch, approval policy and context usage', async () => {
    const store = await seededStore('s1', FULL_BUNDLE)
    const html = render(components.HeaderContextStrip, { sessionId: 's1', store, t })
    assert.match(html, /Error/)
    assert.match(html, /deepseek-v4\.1-flash/)
    assert.match(html, /main/)
    assert.match(html, /ask/)
    assert.match(html, /42%/)
  })

  it('keeps the workspace, preset and depth out of the narrow header strip', async () => {
    const store = await seededStore('s1', FULL_BUNDLE)
    const html = render(components.HeaderContextStrip, { sessionId: 's1', store, t })
    // Those facts live in the hover card and the lineage breadcrumb instead.
    assert.doesNotMatch(html, /acme/)
    assert.doesNotMatch(html, /poteto/)
  })

  it('renders the subagent count when present', async () => {
    const bundle = { ...FULL_BUNDLE, turn: { phase: 'idle' }, subagents: { count: 2 } }
    const store = await seededStore('s4', bundle)
    const html = render(components.HeaderContextStrip, { sessionId: 's4', store, t })
    assert.match(html, /2 subagents/)
  })
})

describe('CopyContextAction', () => {
  it('renders a labelled copy control', () => {
    const store = createContextStore({ effect: (fn) => fn(), on: () => () => {} })
    const html = render(components.CopyContextAction, { sessionId: 's1', store, t })
    assert.match(html, /Copy session context/)
  })
})

describe('SessionMenuItems', () => {
  it('offers branch and directory copies when the bundle carries them', async () => {
    const store = await seededStore('s1', FULL_BUNDLE)
    const Component = makeMenuItems(store)
    const html = render(Component, { sessionId: 's1', store, t })
    assert.match(html, /Copy session context as JSON/)
    assert.match(html, /Copy branch name/)
    assert.match(html, /Copy working directory/)
    assert.match(html, /Compact context/)
  })

  it('offers only the JSON copy when no git facts are known', async () => {
    const store = await seededStore('s3', { sessionId: 's3', live: true, turn: { phase: 'idle' } })
    const Component = makeMenuItems(store)
    const html = render(Component, { sessionId: 's3', store, t })
    assert.match(html, /Copy session context as JSON/)
    assert.match(html, /Compact context/)
    assert.doesNotMatch(html, /Copy branch name/)
    assert.doesNotMatch(html, /Copy working directory/)
  })
})

// --- new surfaces and preferences -------------------------------------------

describe('RowContextAction', () => {
  it('renders one labelled icon button', async () => {
    const store = await seededStore('s1', FULL_BUNDLE)
    const html = render(components.RowContextAction, { sessionId: 's1', store, t })
    assert.match(html, /aria-label="Copy session context"/)
    assert.match(html, /<button/)
  })

  it('renders nothing without a session id', () => {
    const store = createContextStore({ effect: (fn) => fn(), on: () => () => {} })
    assert.equal(render(components.RowContextAction, { store, t }), '')
  })
})

describe('HeaderLineage', () => {
  it('reproduces the shipped title and adds lineage chips', async () => {
    const store = await seededStore('s1', FULL_BUNDLE)
    const html = render(components.HeaderLineage, {
      lineageSessionId: 's1',
      displayTitle: 'parent session',
      store,
      t,
    })
    assert.match(html, /parent session/)
    assert.match(html, /s0/)
    assert.match(html, /poteto/)
    assert.match(html, /d1/)
  })

  it('renders the title as a button when navigation is offered', async () => {
    const store = await seededStore('s1', FULL_BUNDLE)
    const html = render(components.HeaderLineage, {
      lineageSessionId: 's1',
      displayTitle: 'parent session',
      openTitle: () => {},
      store,
      t,
    })
    assert.match(html, /t3s-lineageTitleButton/)
  })

  it('falls back to the bare title when the bundle has no lineage facts', async () => {
    const store = await seededStore('s3', { sessionId: 's3', live: true, status: { kind: 'ready' } })
    const html = render(components.HeaderLineage, { lineageSessionId: 's3', displayTitle: 'a title', store, t })
    assert.match(html, /a title/)
    assert.doesNotMatch(html, /t3s-lineageChips/)
  })
})

describe('resolveStatus from the Host contract', () => {
  it('localizes each rung the Host can report', () => {
    const cases = [
      ['approval', 'Approval', 'approval'],
      ['input', 'Awaiting input', 'input'],
      ['working', 'Working', 'working'],
      ['failed', 'Error', 'failed'],
      ['ready', 'Ready', 'ready'],
    ]
    for (const [kind, label, tone] of cases) {
      const status = resolveStatus({ live: true, status: { kind } }, t)
      assert.equal(status.label, label, `label for ${kind}`)
      assert.equal(status.tone, tone, `tone for ${kind}`)
    }
  })

  it('surfaces the Host error detail on a failed rung', () => {
    const status = resolveStatus({ live: true, status: { kind: 'failed', error: 'boom' } }, t)
    assert.equal(status.detail, 'boom')
  })

  it('reports working for a non-live session the Host still sees running', () => {
    assert.equal(resolveStatus({ live: false, status: { kind: 'working' } }, t).tone, 'working')
  })

  it('falls back to the turn phase when the Host sends no status', () => {
    assert.equal(resolveStatus({ live: true, turn: { phase: 'running' } }, t).tone, 'working')
    assert.equal(resolveStatus({ live: true, turn: { phase: 'failed', error: 'x' } }, t).tone, 'failed')
    assert.equal(resolveStatus({ live: true, subagents: { count: 1 } }, t).tone, 'monitoring')
    assert.equal(resolveStatus({ live: true }, t).tone, 'ready')
  })
})

describe('normalizePrefs', () => {
  it('returns the defaults for an absent or malformed store', () => {
    assert.deepEqual(normalizePrefs(undefined), mod.__internals.defaultPrefs)
    assert.deepEqual(normalizePrefs(null), mod.__internals.defaultPrefs)
    assert.deepEqual(normalizePrefs('nonsense'), mod.__internals.defaultPrefs)
  })

  it('accepts known booleans and drops unknown keys', () => {
    const prefs = normalizePrefs({ showBranch: false, nonsense: true })
    assert.equal(prefs.showBranch, false)
    assert.equal(prefs.nonsense, undefined)
    assert.equal(prefs.showModel, true)
  })

  it('ignores a non-boolean toggle rather than coercing it', () => {
    assert.equal(normalizePrefs({ showBranch: 'no' }).showBranch, true)
  })

  it('accepts a string machine label only', () => {
    assert.equal(normalizePrefs({ machineLabel: 'Box' }).machineLabel, 'Box')
    assert.equal(normalizePrefs({ machineLabel: 7 }).machineLabel, '')
  })
})

describe('preference-driven rendering', () => {
  /** A preferences store backed by an in-memory object. */
  function prefsWith(patch) {
    let value = { ...mod.__internals.defaultPrefs, ...patch }
    return {
      subscribe: () => () => {},
      get: () => value,
      set: (next) => {
        value = { ...value, ...next }
      },
      reset: () => {},
    }
  }

  it('hides a fact when its toggle is off', async () => {
    const store = await seededStore('s1', FULL_BUNDLE)
    const html = render(components.SessionRowHover, { sessionId: 's1', store, t, prefs: prefsWith({ showBranch: false }) })
    assert.doesNotMatch(html, /main \(uncommitted changes\)/)
    // A different fact is unaffected.
    assert.match(html, /deepseek-v4\.1-flash/)
  })

  it('lets the machine-label override win over the reported label', async () => {
    const store = await seededStore('s1', FULL_BUNDLE)
    const html = render(components.SessionRowHover, { sessionId: 's1', store, t, prefs: prefsWith({ machineLabel: 'Build Box' }) })
    assert.match(html, /Build Box/)
    assert.doesNotMatch(html, /Shima&#x27;s MacBook Pro/)
  })

  it('hides a header fact when its toggle is off', async () => {
    const store = await seededStore('s1', FULL_BUNDLE)
    const html = render(components.HeaderContextStrip, { sessionId: 's1', store, t, prefs: prefsWith({ showModel: false }) })
    assert.doesNotMatch(html, /deepseek-v4\.1-flash/)
    assert.match(html, /main/)
  })
})

describe('SettingsRow', () => {
  it('renders a toggle per fact plus the machine-label field', () => {
    const prefs = mod.__internals.createPrefsStore()
    const html = render(components.SettingsRow, { t, prefs })
    assert.match(html, /Display/)
    assert.match(html, /Machine/)
    assert.match(html, /Branch/)
    assert.match(html, /Model/)
    assert.match(html, /Machine label/)
  })

  it('renders with defaults when no preference store is bound', () => {
    const html = render(components.SettingsRow, { t })
    assert.match(html, /Context usage/)
  })
})

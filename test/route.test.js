/**
 * Host route tests.
 *
 * These drive the real `apply()` against a fake Cordis context and call the
 * registered HTTP handler, so the whole host path is exercised: the fence, the
 * JSON envelope, every Service probe, and — critically — the serialisation of
 * the bundle. A probe that is not awaited serialises to `{}`, which the
 * assertions here reject outright, because that failure mode is invisible in
 * any test that inspects the handler's in-memory object instead of its wire
 * output.
 *
 * Run with: node --test test/
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { after, describe, it } from 'node:test'

import { apply } from '../index.js'

/** Temporary directories created by this suite, removed on exit. */
const scratch = []

/** Create a temporary directory that the suite cleans up. */
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/** The working directory this suite's fake session reports. */
const CWD = tempDir('t3s-route-')

/**
 * Build a fake Cordis context that records listeners and routes.
 *
 * @param options - `session` plus any Service overrides.
 * @returns `{ ctx, listeners, routes }`.
 */
function fakeCtx(options) {
  const listeners = []
  const routes = []
  const services = options.services ?? {}
  const ctx = {
    effect: (fn) => {
      const disposer = typeof fn === 'function' ? fn() : undefined
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on: (event, listener) => {
      listeners.push({ event, listener })
      return () => {}
    },
    get: (name) => {
      if (name === 'sessions') {
        return {
          get: (id) => (options.session !== undefined && options.session.header.id === id ? options.session : undefined),
        }
      }
      return Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
    webRuntime: { trustedHosts: [] },
  }
  return { ctx, listeners, routes }
}

/** The fake live session every route in this suite reads. */
function fakeSession() {
  return {
    header: {
      id: 's1',
      createdAt: 1,
      cwd: CWD,
      agentPreset: 'poteto',
      parentSession: 's0',
      delegationDepth: 1,
      isSeeded: false,
    },
    requestContext: () => ({ provider: 'opencode-go', model: 'deepseek-v4.1-flash', contextWindow: 200000 }),
    requestHeader: () => ({
      config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
    }),
    snapshotEvents: () => [{ type: 'turn/start', data: { turn: 1 } }],
    seq: 7,
  }
}

/** Service overrides covering every probe the bundle performs. */
function fakeServices(overrides = {}) {
  return {
    tokenMeter: {
      measure: () => ({
        totalTokens: 83000,
        baseline: { kind: 'usage', tokens: 83000 },
        surfaceDeltaTokens: 0,
        nodes: [{ seq: 1, tokens: 10, heuristicTokens: 10 }],
        logRevision: 7,
      }),
    },
    approval: { overrideOf: () => 'ask' },
    subagents: { listChildren: async () => [] },
    agents: { get: () => ({ id: 's1' }) },
    goals: { get: () => undefined },
    ...overrides,
  }
}

/**
 * Invoke one registered route and return its parsed response.
 *
 * @param handler - The route handler.
 * @param path - Request path.
 * @param body - JSON body.
 * @param options - Optional method and Host header overrides.
 * @returns `{ status, envelope }`.
 */
async function callRoute(handler, path, body, options = {}) {
  const payload = Buffer.from(JSON.stringify(body ?? {}))
  const request = {
    method: options.method ?? 'POST',
    url: path,
    headers: { host: options.host ?? '127.0.0.1:19387', ...(options.headers ?? {}) },
    async *[Symbol.asyncIterator]() {
      yield payload
    },
  }
  let captured
  const response = {
    status: undefined,
    writeHead(status) {
      this.status = status
    },
    end(text) {
      captured = { status: this.status, text }
    },
  }
  await handler(request, response)
  assert.ok(captured !== undefined, 'route must write a response')
  return { status: captured.status, envelope: JSON.parse(captured.text) }
}

/** Find a recorded listener by event name. */
function listenerFor(listeners, event) {
  const found = listeners.filter((entry) => entry.event === event)
  assert.ok(found.length > 0, `no listener registered for ${event}`)
  return found[0].listener
}

/** Mount the plugin and return its route handler plus recorded listeners. */
function mount(options = {}) {
  const session = options.session ?? fakeSession()
  const { ctx, listeners, routes } = fakeCtx({
    session,
    services: options.services ?? fakeServices(),
  })
  apply(ctx, options.config)
  assert.equal(routes.length, 1, 'exactly one route is registered')
  return { handler: routes[0].handler, listeners, session }
}

// ---------------------------------------------------------------------------

describe('sessionContext route', () => {
  it('serialises every fact as a real value, never a pending Promise', async () => {
    const { handler } = mount()
    const { status, envelope } = await callRoute(handler, '/t3session/api/sessionContext', { sessionId: 's1' })
    assert.equal(status, 200)
    assert.equal(envelope.ok, true)
    const bundle = envelope.value
    assert.equal(bundle.provider, 'opencode-go')
    assert.equal(bundle.model, 'deepseek-v4.1-flash')
    assert.equal(bundle.contextWindow, 200000)
    assert.equal(bundle.reasoningEffort, 'high')
    assert.equal(bundle.turn.phase, 'running')
    assert.equal(bundle.status.kind, 'working')
    assert.equal(bundle.tokens.used, 83000)
    assert.equal(bundle.tokens.max, 200000)
    assert.equal(bundle.tokens.usedPercent, 41.5)
    assert.equal(bundle.approval.policy, 'ask')
    assert.equal(bundle.preset, 'poteto')
    assert.equal(bundle.parentSession, 's0')
    assert.equal(bundle.delegationDepth, 1)
    assert.equal(bundle.seq, 7)
    assert.equal(bundle.cwd, CWD)
    assert.equal(bundle.workspaceName, basename(CWD))
    assert.equal(typeof bundle.machine.machineLabel, 'string')
  })

  it('never leaks an empty object from an unresolved probe', async () => {
    const { handler } = mount()
    const { envelope } = await callRoute(handler, '/t3session/api/sessionContext', { sessionId: 's1' })
    for (const [key, value] of Object.entries(envelope.value)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      assert.ok(
        Object.keys(value).length > 0,
        `"${key}" is an empty object, which means a probe was not awaited`,
      )
    }
  })

  it('omits facts whose Services are absent rather than failing', async () => {
    const { handler } = mount({
      services: { agents: undefined, goals: undefined, approval: undefined, subagents: undefined, tokenMeter: undefined },
    })
    const { status, envelope } = await callRoute(handler, '/t3session/api/sessionContext', { sessionId: 's1' })
    assert.equal(status, 200)
    const bundle = envelope.value
    assert.equal(bundle.tokens, undefined)
    assert.equal(bundle.approval, undefined)
    assert.equal(bundle.subagents, undefined)
    assert.equal(bundle.goal, undefined)
    // The facts that do not need a Service are still present.
    assert.equal(bundle.model, 'deepseek-v4.1-flash')
  })

  it('reports a non-live session without erroring', async () => {
    const { handler } = mount()
    const { status, envelope } = await callRoute(handler, '/t3session/api/sessionContext', { sessionId: 'nope' })
    assert.equal(status, 200)
    assert.equal(envelope.value.live, false)
    assert.equal(envelope.value.status.kind, 'offline')
  })

  it('rejects a missing sessionId', async () => {
    const { handler } = mount()
    const { status, envelope } = await callRoute(handler, '/t3session/api/sessionContext', {})
    assert.equal(status, 400)
    assert.equal(envelope.ok, false)
  })

  it('reports an errored turn', async () => {
    const session = fakeSession()
    session.snapshotEvents = () => [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } },
    ]
    const { handler } = mount({ session })
    const { envelope } = await callRoute(handler, '/t3session/api/sessionContext', { sessionId: 's1' })
    assert.equal(envelope.value.status.kind, 'failed')
    assert.equal(envelope.value.status.error, 'boom')
  })
})

describe('hostFacts route', () => {
  it('returns a machine identity without needing a session', async () => {
    const { handler } = mount()
    const { status, envelope } = await callRoute(handler, '/t3session/api/hostFacts', {})
    assert.equal(status, 200)
    assert.equal(typeof envelope.value.hostname, 'string')
    assert.equal(typeof envelope.value.machineLabel, 'string')
    assert.equal(envelope.value.machineLabelIsCustom, false)
  })

  it('honours a configured machine label', async () => {
    const { handler } = mount({ config: { machineLabel: "Shima's MacBook Pro" } })
    const { envelope } = await callRoute(handler, '/t3session/api/hostFacts', {})
    assert.equal(envelope.value.machineLabel, "Shima's MacBook Pro")
    assert.equal(envelope.value.machineLabelIsCustom, true)
  })
})

describe('route fencing', () => {
  it('rejects a foreign Host', async () => {
    const { handler } = mount()
    const { status, envelope } = await callRoute(handler, '/t3session/api/hostFacts', {}, { host: 'evil.example.com' })
    assert.equal(status, 403)
    assert.equal(envelope.error.code, 'forbidden')
  })

  it('rejects a cross-site marker', async () => {
    const { handler } = mount()
    const { status } = await callRoute(handler, '/t3session/api/hostFacts', {}, { headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(status, 403)
  })

  it('rejects a non-POST method', async () => {
    const { handler } = mount()
    const { status, envelope } = await callRoute(handler, '/t3session/api/hostFacts', {}, { method: 'GET' })
    assert.equal(status, 405)
    assert.equal(envelope.error.code, 'method-error')
  })

  it('rejects an unknown method', async () => {
    const { handler } = mount()
    const { status, envelope } = await callRoute(handler, '/t3session/api/nope', {})
    assert.equal(status, 404)
    assert.equal(envelope.error.code, 'not-found')
  })
})

describe('live status rungs', () => {
  it('reports working from the liveness event even when the log shows no open turn', async () => {
    const session = fakeSession()
    session.snapshotEvents = () => []
    const { handler, listeners } = mount({ session })
    listenerFor(listeners, 'api-session/status')('s1', true)
    const { envelope } = await callRoute(handler, '/t3session/api/sessionContext', { sessionId: 's1' })
    assert.equal(envelope.value.status.kind, 'working')
    assert.equal(envelope.value.status.running, true)
  })

  it('reports pending approval only while the approval ask is outstanding', async () => {
    const session = fakeSession()
    session.snapshotEvents = () => []
    const { handler, listeners } = mount({ session })
    const ask = listenerFor(listeners, 'approval/request')

    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const pending = ask.call({ id: 's1' }, { toolName: 'bash' }, () => gate)

    const during = await callRoute(handler, '/t3session/api/sessionContext', { sessionId: 's1' })
    assert.equal(during.envelope.value.status.kind, 'approval')
    assert.equal(during.envelope.value.status.pendingApprovals, 1)

    release('allow')
    await pending

    const after = await callRoute(handler, '/t3session/api/sessionContext', { sessionId: 's1' })
    assert.equal(after.envelope.value.status.kind, 'ready')
    assert.equal(after.envelope.value.status.pendingApprovals, 0)
  })

  it('reports awaiting input while a question is outstanding', async () => {
    const session = fakeSession()
    session.snapshotEvents = () => []
    const { handler, listeners } = mount({ session })
    const ask = listenerFor(listeners, 'user-questions/request')
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const pending = ask.call({ id: 's1' }, { questions: [] }, () => gate)
    const during = await callRoute(handler, '/t3session/api/sessionContext', { sessionId: 's1' })
    assert.equal(during.envelope.value.status.kind, 'input')
    release({})
    await pending
  })

  it('lets pending approval outrank a running agent', async () => {
    const session = fakeSession()
    const { handler, listeners } = mount({ session })
    listenerFor(listeners, 'api-session/status')('s1', true)
    const ask = listenerFor(listeners, 'approval/request')
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const pending = ask.call({ id: 's1' }, {}, () => gate)
    const { envelope } = await callRoute(handler, '/t3session/api/sessionContext', { sessionId: 's1' })
    assert.equal(envelope.value.status.kind, 'approval')
    release()
    await pending
  })

  it('reports subagent fan-out when nothing else is live', async () => {
    const session = fakeSession()
    session.snapshotEvents = () => []
    const { handler } = mount({
      session,
      services: fakeServices({ subagents: { listChildren: async () => [{ id: 'c1' }, { id: 'c2' }] } }),
    })
    const { envelope } = await callRoute(handler, '/t3session/api/sessionContext', { sessionId: 's1' })
    assert.equal(envelope.value.status.kind, 'monitoring')
    assert.equal(envelope.value.subagents.count, 2)
  })

  it('reports a session error raised outside a turn', async () => {
    const session = fakeSession()
    session.snapshotEvents = () => []
    const { handler, listeners } = mount({ session })
    listenerFor(listeners, 'api-session/error')('s1', 'provider exploded')
    const { envelope } = await callRoute(handler, '/t3session/api/sessionContext', { sessionId: 's1' })
    assert.equal(envelope.value.status.kind, 'failed')
    assert.equal(envelope.value.status.error, 'provider exploded')
  })
})

describe('compact route', () => {
  it('runs the DSH compact command through the command registry', async () => {
    const executed = []
    const { handler } = mount({
      services: fakeServices({
        commands: {
          execute: async (agent, line) => {
            executed.push({ agent, line })
            return { matched: true }
          },
        },
      }),
    })
    const { status, envelope } = await callRoute(handler, '/t3session/api/compact', { sessionId: 's1' })
    assert.equal(status, 200)
    assert.equal(envelope.value.matched, true)
    assert.equal(executed.length, 1)
    assert.equal(executed[0].line, '/compact')
  })

  it('fails cleanly when the session has no live agent', async () => {
    const { handler } = mount({ services: fakeServices({ agents: { get: () => undefined } }) })
    const { status, envelope } = await callRoute(handler, '/t3session/api/compact', { sessionId: 's1' })
    assert.equal(status, 409)
    assert.equal(envelope.error.code, 'no-agent')
  })

  it('fails cleanly when the command registry is unavailable', async () => {
    const { handler } = mount({ services: fakeServices({ commands: undefined }) })
    const { status, envelope } = await callRoute(handler, '/t3session/api/compact', { sessionId: 's1' })
    assert.equal(status, 503)
    assert.equal(envelope.error.code, 'unavailable')
  })
})

describe('response writing resilience', () => {
  /**
   * Invoke one route against a response whose `writeHead` throws, which is what
   * a wrapping middleware can do when a plugin sets its own `content-length`.
   * The handler must still produce a JSON envelope rather than letting DSH
   * answer with a bare, anonymous 400.
   */
  async function callWithBrokenWriteHead(handler, path, body) {
    const payload = Buffer.from(JSON.stringify(body ?? {}))
    const request = {
      method: 'POST',
      url: path,
      headers: { host: '127.0.0.1:19387' },
      async *[Symbol.asyncIterator]() {
        yield payload
      },
    }
    let captured
    const response = {
      statusCode: undefined,
      headers: {},
      writeHead() {
        throw new Error('wrapper refused writeHead')
      },
      setHeader(name, value) {
        this.headers[name] = value
      },
      end(text) {
        captured = { status: this.statusCode, text }
      },
    }
    await handler(request, response)
    assert.ok(captured !== undefined, 'a response must still be written')
    return captured
  }

  it('still writes a JSON envelope when writeHead throws', async () => {
    const { handler } = mount()
    const captured = await callWithBrokenWriteHead(handler, '/t3session/api/hostFacts', {})
    assert.equal(captured.status, 200)
    const envelope = JSON.parse(captured.text)
    assert.equal(envelope.ok, true)
    assert.equal(typeof envelope.value.hostname, 'string')
  })

  it('still writes the fence rejection when writeHead throws', async () => {
    const { handler } = mount()
    const payload = Buffer.from('{}')
    const request = {
      method: 'POST',
      url: '/t3session/api/hostFacts',
      headers: { host: 'evil.example.com' },
      async *[Symbol.asyncIterator]() {
        yield payload
      },
    }
    let captured
    const response = {
      statusCode: undefined,
      writeHead() {
        throw new Error('wrapper refused writeHead')
      },
      setHeader() {},
      end(text) {
        captured = { status: this.statusCode, text }
      },
    }
    await handler(request, response)
    assert.equal(captured.status, 403)
    assert.equal(JSON.parse(captured.text).error.code, 'forbidden')
  })

  it('survives a response that throws on every write path', async () => {
    const { handler } = mount()
    const payload = Buffer.from('{}')
    const request = {
      method: 'POST',
      url: '/t3session/api/hostFacts',
      headers: { host: '127.0.0.1:19387' },
      async *[Symbol.asyncIterator]() {
        yield payload
      },
    }
    const response = {
      writeHead() {
        throw new Error('nope')
      },
      setHeader() {
        throw new Error('nope')
      },
      end() {
        throw new Error('nope')
      },
    }
    // The handler must swallow this rather than reject the route.
    await handler(request, response)
  })
})

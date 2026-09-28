/**
 * Host half of the T3 session-context bundle.
 *
 * The whole feature is browser-side; this half exists because the facts the
 * UI shows are not reachable from the browser:
 *
 *   - the machine identity            (`node:os`, not exposed on the wire)
 *   - the session's working directory (`Session.header.cwd`)
 *   - the routed provider/model and the model's context window
 *     (`Session.requestContext()`)
 *   - git branch / dirty state        (a git invocation in that directory)
 *   - live token pressure             (`ctx.tokenMeter.measure()`)
 *   - approval policy                 (`ctx.approval.overrideOf()`)
 *   - compaction                      (`ctx.commands.execute('/compact')`)
 *
 * None of those Services carry a `@Remote` face, so the Client half cannot
 * reach them through `ctx.remote`. They are served instead as one JSON RPC
 * endpoint on DSH's own web server (the same bridge `dsh-better-sidebar` and
 * `@michengai/dsh-codex-ui` use), fenced to same-origin loopback callers.
 *
 * Every probe is individually guarded and the bundle degrades field by field:
 * a fact that cannot be read is omitted rather than faked, so a session whose
 * provider never reported a context window simply has no `tokens.max`.
 *
 * @module dsh-t3-session-ui
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { arch, homedir, hostname, platform, release } from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * This package's own version, read from its `package.json`.
 *
 * Reported in `hostFacts` so a bug report can name the build that produced it.
 * Read rather than hardcoded: a literal here silently goes stale on the next
 * release, which is exactly what a version field must never do.
 */
const PACKAGE_VERSION = (() => {
  try {
    const parsed = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** Plugin id; also the Client bundle's module id and the route's namespace. */
export const name = 'dsh-t3-session-ui'

/** Route prefix the Client half POSTs to. */
const ROUTE_PREFIX = '/t3session/api'

/**
 * Hard dependency only on the web carrier: every other Service this half reads
 * is optional, so the plugin still loads (and simply reports fewer facts) in a
 * composition that omits token metering, approvals, or git.
 */
export const inject = ['webServer']

/** Upper bound on any single git invocation, so a hung repo cannot stall the RPC. */
const GIT_TIMEOUT_MS = 4000

/** How long a git probe result is reused before the next RPC re-runs git. */
const GIT_CACHE_MS = 5000

/** Largest request body accepted by the RPC route. */
const MAX_BODY_BYTES = 64 * 1024

/** Loopback hostnames, which are always acceptable for this route. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

// ------------------------------------------------------------------ utilities

/**
 * Read one header value case-insensitively, collapsing an array-valued header.
 *
 * @param headers - Node request headers.
 * @param key - Lower-case header name.
 * @returns the header string, or undefined when absent.
 */
function readHeader(headers, key) {
  const value = headers[key]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length > 0) return value[0]
  return undefined
}

/**
 * Whether one request may reach this plugin's route.
 *
 * The route serves facts about the local machine and the local filesystem, so
 * it is fenced the same way the other DSH plugin routes are: the Host must be
 * loopback (or an authority this deployment declares trusted), the browser must
 * not mark the request cross-site, and a present Origin must match the Host.
 *
 * @param request - Node HTTP request.
 * @param trustedHosts - Non-loopback authorities this deployment serves.
 * @returns true when the request is same-origin and local.
 */
function isTrustedRequest(request, trustedHosts) {
  const rawHost = readHeader(request.headers, 'host')
  if (rawHost === undefined) return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${rawHost}`)
  } catch {
    return false
  }
  const trusted = Array.isArray(trustedHosts)
    ? trustedHosts.some((entry) => {
        try {
          const entryUrl = new URL(`http://${String(entry)}`)
          return entryUrl.host === hostUrl.host
        } catch {
          return false
        }
      })
    : false
  if (!LOOPBACK_HOSTNAMES.has(hostUrl.hostname) && !trusted) return false
  if (readHeader(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = readHeader(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/**
 * Read and parse a bounded JSON request body.
 *
 * @param request - Node HTTP request.
 * @returns the parsed body, defaulting to an empty object.
 */
async function readJsonBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new PluginError('payload-too-large', 'request body too large', 413)
    chunks.push(chunk)
  }
  if (total === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new PluginError('bad-json', 'request body is not valid JSON', 400)
  }
}

/**
 * Write one JSON response, never throwing.
 *
 * Only `content-type` is set on the primary path. DSH's web server wraps plugin
 * route responses (compression, `Vary`), and an extra `content-length` or
 * `cache-control` can make that wrapper throw — which surfaces as a bare
 * `400 Bad Request` with no body and no `content-type`, indistinguishable from a
 * missing route. The primary shape mirrors `dsh-better-sidebar`, whose writer
 * sets the content type and nothing else; the fallbacks keep a throwing wrapper
 * from turning every response into that anonymous 400.
 *
 * @param response - Node HTTP response.
 * @param status - HTTP status code.
 * @param body - Serialisable body.
 */
function writeJson(response, status, body) {
  let payload
  try {
    payload = JSON.stringify(body)
  } catch {
    payload = '{"ok":false,"error":{"code":"unserialisable","message":"response was not serialisable"}}'
  }
  try {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(payload)
    return
  } catch {
    /* fall through to the lower-level shapes */
  }
  try {
    response.statusCode = status
    response.setHeader?.('content-type', 'application/json; charset=utf-8')
    response.end(payload)
    return
  } catch {
    /* fall through */
  }
  try {
    response.end(payload)
  } catch {
    /* the response is already unusable; nothing further we can do */
  }
}

/** A wire error carrying the code and status the Client half surfaces. */
class PluginError extends Error {
  /**
   * @param code - Stable machine code.
   * @param message - Human-readable message.
   * @param status - HTTP status to answer with.
   */
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'PluginError'
    this.code = code
    this.status = status
  }
}

/**
 * Turn a friendly machine label out of a hostname.
 *
 * `Shimas-MacBook-Pro.local` becomes `Shima's MacBook Pro`; anything the
 * heuristic cannot improve on is returned trimmed and unchanged, so a hostname
 * like `buildbox` stays `buildbox`.
 *
 * @param raw - The `os.hostname()` value.
 * @returns a display label.
 */
function friendlyMachineLabel(raw) {
  const withoutDomain = String(raw).replace(/\.local$/i, '').replace(/\.$/, '')
  const words = withoutDomain.split(/[-_]+/).filter((word) => word !== '')
  if (words.length === 0) return String(raw)
  const possessive = `${words[0]}'s`
  const rest = words
    .slice(1)
    .map((word) => (/^[A-Z0-9]+$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
  return rest === '' ? words[0] : `${possessive} ${rest}`
}

/**
 * Reduce a throwaway probe into a value or undefined, so one unavailable fact
 * never fails the whole bundle.
 *
 * @param probe - Synchronous or asynchronous probe.
 * @returns the probe's value, or undefined when it threw or returned null.
 */
async function attempt(probe) {
  try {
    const value = await probe()
    return value === null || value === undefined ? undefined : value
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- git probing

/** Memoised git probes, keyed by working directory. */
const gitCache = new Map()

/**
 * Probe git facts for one directory.
 *
 * Returns undefined when the directory is not inside a work tree (or git is
 * unavailable), which is the signal to omit the branch row entirely rather
 * than render a placeholder.
 *
 * @param cwd - Absolute directory to probe.
 * @returns `{ branch, dirty, worktree, root }`, or undefined when not a repo.
 */
async function probeGit(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return undefined
  const cached = gitCache.get(cwd)
  if (cached !== undefined && Date.now() - cached.at < GIT_CACHE_MS) return cached.value
  const options = { cwd, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true }
  let value
  try {
    const [branchResult, statusResult, rootResult, commonResult] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], options),
      execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=no'], options),
      execFileAsync('git', ['rev-parse', '--show-toplevel'], options),
      execFileAsync('git', ['rev-parse', '--git-common-dir'], options),
    ])
    const branch = String(branchResult.stdout).trim()
    const root = String(rootResult.stdout).trim()
    const commonDir = String(commonResult.stdout).trim()
    value = {
      branch: branch === '' ? undefined : branch,
      detached: branch === 'HEAD',
      dirty: String(statusResult.stdout).trim() !== '',
      root: root === '' ? undefined : root,
      // A worktree's common dir lives outside the work tree; a plain checkout's
      // is `<root>/.git`, so an absolute common dir that differs from that
      // marks a linked worktree.
      worktree: commonDir !== '.git' && commonDir !== '' && root !== '' ? cwd : undefined,
    }
  } catch {
    value = undefined
  }
  gitCache.set(cwd, { at: Date.now(), value })
  return value
}

// ------------------------------------------------------- session-log digestion

/**
 * Derive the coarse turn lifecycle from a session's own event log.
 *
 * The session log is the only liveness signal that is both live and
 * host-observable, so the status is read from the lifecycle events rather than
 * guessed from agent-registry presence (which stays true while a session idles).
 *
 * @param session - A live DSH `Session`.
 * @returns `{ phase, error }` where phase is `running`, `failed`, or `idle`.
 */
function deriveTurnPhase(session) {
  let phase = 'idle'
  let error
  let openTurn = false
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start') {
      openTurn = true
      continue
    }
    if (event.type !== 'turn/end') continue
    openTurn = false
    const reason = event.data?.reason
    if (reason?.kind === 'error') {
      phase = 'failed'
      error = reason.error?.message
    } else if (reason?.kind === 'aborted' || reason?.kind === 'interrupted') {
      phase = 'failed'
      error = reason.kind === 'interrupted' ? 'Interrupted' : reason.reason?.kind
    } else {
      phase = 'idle'
      error = undefined
    }
  }
  if (openTurn) return { phase: 'running', error: undefined }
  return { phase, error }
}

// ------------------------------------------------------------- live session state

/**
 * Resolve the Session id a scoped host event belongs to.
 *
 * DSH dispatches `agent/status`, `approval/request`, and `user-questions/request`
 * with `this: Scoped<Agent>`, so the subject is the agent whose `id` is the
 * Session id. The probes are deliberately generous and return undefined rather
 * than guessing, because an unresolvable id must only cost a status rung — it
 * must never attribute one session's work to another.
 *
 * @param scoped - The listener's `this`.
 * @param payload - The event payload, which may carry the agent.
 * @returns a Session id, or undefined when it cannot be established.
 */
function resolveEventSessionId(scoped, payload) {
  const candidates = [
    scoped?.id,
    scoped?.agent?.id,
    payload?.agent?.id,
    payload?.sessionId,
    payload?.session?.id,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/**
 * Live per-session state assembled from host events.
 *
 * The session log alone cannot answer "is this waiting on the human", because a
 * pending approval and a pending question are process-local, not durable. They
 * ARE observable as waterfalls: a listener wraps `next()` and therefore knows
 * exactly how long the ask is outstanding. This tracker keeps those counts plus
 * the agent's running flag, which is the cheapest accurate liveness signal.
 *
 * @returns the tracker: `wire(ctx)` attaches listeners, `read(id)` snapshots.
 */
function createLiveState() {
  /** @type {Map<string, {running: boolean, approvals: number, questions: number, error?: string}>} */
  const sessions = new Map()
  /** Sessions seen running at least once, so `running: false` stays meaningful. */
  const known = new Set()

  /**
   * Read (creating on demand) one session's mutable state.
   *
   * @param sessionId - Session to read.
   * @returns the mutable record.
   */
  const entryFor = (sessionId) => {
    let entry = sessions.get(sessionId)
    if (entry === undefined) {
      entry = { running: false, approvals: 0, questions: 0 }
      sessions.set(sessionId, entry)
    }
    return entry
  }

  /**
   * Wrap one ask-shaped waterfall so the outstanding count brackets `next()`.
   *
   * @param field - Which counter to move (`approvals` or `questions`).
   * @returns the waterfall listener.
   */
  const askListener = (field) =>
    async function askWaterfall(payload, next) {
      const sessionId = resolveEventSessionId(this, payload)
      if (sessionId === undefined) return next()
      const entry = entryFor(sessionId)
      entry[field] += 1
      try {
        return await next()
      } finally {
        entry[field] = Math.max(0, entry[field] - 1)
      }
    }

  return {
    /**
     * Attach the host listeners that keep the tracker current.
     *
     * @param ctx - The plugin's Host-side context.
     */
    wire(ctx) {
      ctx.effect(
        () =>
          ctx.on('api-session/status', (sessionId, running) => {
            if (typeof sessionId !== 'string' || sessionId === '') return
            const entry = entryFor(sessionId)
            entry.running = running === true
            if (running === true) known.add(sessionId)
          }),
        'dsh-t3-session-ui: session liveness',
      )
      ctx.effect(
        () =>
          ctx.on('api-session/error', (sessionId, message) => {
            if (typeof sessionId !== 'string' || sessionId === '') return
            entryFor(sessionId).error = typeof message === 'string' ? message : undefined
          }),
        'dsh-t3-session-ui: session errors',
      )
      // Waterfalls: `this` is the scoped Agent, and the listener brackets the
      // ask, so the count is exact while the human is deciding.
      ctx.effect(() => ctx.on('approval/request', askListener('approvals')), 'dsh-t3-session-ui: pending approvals')
      ctx.effect(() => ctx.on('user-questions/request', askListener('questions')), 'dsh-t3-session-ui: pending questions')
      // A durable turn boundary clears a stale process-local error.
      ctx.effect(
        () =>
          ctx.on('session/event', (_session, event) => {
            if (event?.type === 'turn/start') {
              const sessionId = resolveEventSessionId(_session, event)
              if (sessionId === undefined) return
              const entry = entryFor(sessionId)
              entry.error = undefined
              known.add(sessionId)
            }
          }),
        'dsh-t3-session-ui: turn boundaries',
      )
    },

    /**
     * Snapshot one session's live state.
     *
     * @param sessionId - Session to read.
     * @returns the counters, plus whether the session was ever seen running.
     */
    read(sessionId) {
      const entry = sessions.get(sessionId)
      return {
        running: entry?.running === true,
        approvals: entry?.approvals ?? 0,
        questions: entry?.questions ?? 0,
        error: entry?.error,
        everRan: known.has(sessionId),
      }
    },
  }
}

/**
 * Resolve the status rung for one session, in T3 Code's precedence order:
 * pending approval, then awaiting input, then working, then failure, then
 * background work, then ready.
 *
 * @param live - The live counters for this session.
 * @param turn - The derived turn phase, used as the fallback when no live
 *   liveness signal has been observed for this session.
 * @param subagentCount - Number of live children.
 * @returns `{ kind, error }`.
 */
function resolveStatusKind(live, turn, subagentCount) {
  if (live.approvals > 0) return { kind: 'approval', error: undefined }
  if (live.questions > 0) return { kind: 'input', error: undefined }
  const running = live.running || turn?.phase === 'running'
  if (running) return { kind: 'working', error: undefined }
  if (turn?.phase === 'failed' || live.error !== undefined) {
    return { kind: 'failed', error: live.error ?? turn?.error }
  }
  if (subagentCount > 0) return { kind: 'monitoring', error: undefined }
  return { kind: 'ready', error: undefined }
}

// ------------------------------------------------------------------- handlers

/**
 * Build the API handlers bound to one Cordis context.
 *
 * @param ctx - The plugin's Host-side context.
 * @param config - Resolved plugin configuration.
 * @param liveState - Live per-session state assembled from host events.
 * @returns a method table addressed by the route.
 */
function buildApi(ctx, config, liveState) {
  const hostFacts = async () => {
    // Every probe is awaited: `attempt` is async, and an unawaited one would
    // serialise to `{}` (or stringify a Promise into the machine label).
    const raw = (await attempt(() => hostname())) ?? 'unknown'
    return {
      hostname: raw,
      machineLabel: config.machineLabel !== '' ? config.machineLabel : friendlyMachineLabel(raw),
      machineLabelIsCustom: config.machineLabel !== '',
      platform: await attempt(() => platform()),
      arch: await attempt(() => arch()),
      release: await attempt(() => release()),
      home: await attempt(() => homedir()),
      node: process.version,
      pluginVersion: config.pluginVersion,
    }
  }

  /**
   * Read every fact this plugin can report about one session.
   *
   * @param payload - `{ sessionId }`.
   * @returns the context bundle; every field is independently optional.
   */
  const sessionContext = async (payload) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
    if (sessionId === '') throw new PluginError('bad-request', 'sessionId is required', 400)
    const sessions = ctx.get('sessions')
    const session = sessions?.get?.(sessionId)
    if (session === undefined) {
      // A session that is not live in this process is still worth answering
      // for: the row may belong to another generation. Report non-live rather
      // than erroring, so the Client half renders the offline state.
      const offlineLive = liveState.read(sessionId)
      return {
        sessionId,
        live: false,
        machine: await hostFacts(),
        status: { kind: offlineLive.running ? 'working' : 'offline', error: offlineLive.error },
      }
    }

    const header = session.header ?? {}
    const cwd = typeof header.cwd === 'string' ? header.cwd : undefined
    // Every probe below MUST be awaited: `attempt` is async, so a missing
    // `await` would serialise a Promise to `{}` in the wire bundle and the
    // Client would silently render nothing for that fact.
    const requestContext = await attempt(() => session.requestContext())
    const requestHeader = await attempt(() => session.requestHeader())
    const phase = await attempt(() => deriveTurnPhase(session))

    const tokens = await attempt(() => {
      const meter = ctx.get('tokenMeter')
      if (meter === undefined || typeof meter.measure !== 'function') return undefined
      const measurement = meter.measure(session)
      const used = Number(measurement?.totalTokens)
      if (!Number.isFinite(used)) return undefined
      const max = Number(requestContext?.contextWindow)
      const hasMax = Number.isFinite(max) && max > 0
      return {
        used,
        max: hasMax ? max : undefined,
        usedPercent: hasMax ? Math.min(100, (used / max) * 100) : undefined,
        baselineKind: measurement?.baseline?.kind,
        surfaceDeltaTokens: measurement?.surfaceDeltaTokens,
        nodeCount: Array.isArray(measurement?.nodes) ? measurement.nodes.length : undefined,
        logRevision: measurement?.logRevision,
      }
    })

    const approval = await attempt(() => {
      const service = ctx.get('approval')
      if (service === undefined || typeof service.overrideOf !== 'function') return undefined
      const policy = service.overrideOf(session)
      return policy === undefined ? undefined : { policy }
    })

    const subagents = await attempt(() => {
      const service = ctx.get('subagents')
      if (service === undefined || typeof service.listChildren !== 'function') return undefined
      return service.listChildren(sessionId).then((children) => ({
        count: Array.isArray(children) ? children.length : 0,
      }))
    })

    const goal = await attempt(() => {
      const agents = ctx.get('agents')
      const agent = agents?.get?.(sessionId)
      if (agent === undefined) return undefined
      const service = ctx.get('goals')
      if (service === undefined || typeof service.get !== 'function') return undefined
      const view = service.get(agent)
      if (view === undefined || view === null) return undefined
      return { objective: view.objective, phase: view.phase, rounds: view.roundsStarted }
    })

    const workspaceName = cwd === undefined ? undefined : cwd.split('/').filter(Boolean).pop()

    const live = liveState.read(sessionId)
    const subagentCount = subagents?.count ?? 0
    const status = resolveStatusKind(live, phase, subagentCount)

    return {
      sessionId,
      live: true,
      machine: await hostFacts(),
      cwd,
      workspaceName,
      git: await probeGit(cwd),
      provider: requestContext?.provider,
      model: requestContext?.model,
      contextWindow: requestContext?.contextWindow,
      reasoningEffort: requestHeader?.config?.reasoningEffort,
      preset: header.agentPreset,
      parentSession: header.parentSession,
      delegationDepth: header.delegationDepth,
      origin: header.origin,
      isSeeded: header.isSeeded,
      createdAt: header.createdAt,
      seq: await attempt(() => session.seq),
      turn: phase,
      // The resolved rung is computed here because only the Host sees the
      // process-local approval and question waterfalls; the Client localizes it.
      status: {
        kind: status.kind,
        error: status.error,
        running: live.running,
        pendingApprovals: live.approvals,
        awaitingInput: live.questions,
      },
      approval: await approval,
      subagents: await subagents,
      goal: await goal,
      tokens: await tokens,
    }
  }

  /**
   * Trigger DSH's own compaction for one session by running its `/compact`
   * command, so this plugin never reimplements compaction.
   *
   * @param payload - `{ sessionId }`.
   * @returns `{ matched }` as the command registry reports it.
   */
  const compact = async (payload) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
    if (sessionId === '') throw new PluginError('bad-request', 'sessionId is required', 400)
    const agents = ctx.get('agents')
    const agent = agents?.get?.(sessionId)
    if (agent === undefined) throw new PluginError('no-agent', 'session is not live in this process', 409)
    const commands = ctx.get('commands')
    if (commands === undefined || typeof commands.execute !== 'function') {
      throw new PluginError('unavailable', 'the command registry is unavailable', 503)
    }
    const execution = await commands.execute(agent, '/compact', [], new AbortController().signal)
    return { matched: execution?.matched === true, execution: execution ?? null }
  }

  return { hostFacts, sessionContext, compact }
}

/**
 * Resolve the plugin configuration, applying defaults for direct callers.
 *
 * @param config - Loader-provided configuration, if any.
 * @returns the complete configuration.
 */
function resolveConfig(config) {
  const machineLabel = typeof config?.machineLabel === 'string' ? config.machineLabel.trim() : ''
  return {
    machineLabel,
    pluginVersion: typeof config?.pluginVersion === 'string' ? config.pluginVersion : PACKAGE_VERSION,
  }
}

// Pure helpers exported for the package's own tests. They are internal: the
// Loader only consumes `name`, `inject`, and `apply`, and nothing else in DSH
// should depend on these signatures.
export {
  createLiveState,
  deriveTurnPhase,
  friendlyMachineLabel,
  isTrustedRequest,
  probeGit,
  resolveConfig,
  resolveEventSessionId,
  resolveStatusKind,
}

/**
 * Mount the Host half: one fenced JSON RPC route on DSH's web server.
 *
 * @param ctx - The plugin's Host-side context.
 * @param config - Loader-provided configuration.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const liveState = createLiveState()
  liveState.wire(ctx)
  const api = buildApi(ctx, resolved, liveState)

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (request, response) => {
          // Read the trusted-host list through `ctx.get` inside a guard: a
          // Cordis service accessor can THROW for an unregistered name, and
          // optional chaining does not catch that, so a direct
          // `ctx.webRuntime?.trustedHosts` could fail every request before a
          // response is ever written.
          let trustedHosts
          try {
            const webRuntime = typeof ctx.get === 'function' ? ctx.get('webRuntime') : undefined
            trustedHosts = webRuntime?.trustedHosts
          } catch {
            trustedHosts = undefined
          }
          if (!isTrustedRequest(request, trustedHosts)) {
            writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
            return
          }
          if (request.method !== 'POST') {
            writeJson(response, 405, { ok: false, error: { code: 'method-error', message: 'POST required' } })
            return
          }
          const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith(`${ROUTE_PREFIX}/`) ? pathname.slice(ROUTE_PREFIX.length + 1) : undefined
          if (method === undefined || method === '' || method.includes('/')) {
            writeJson(response, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
            return
          }
          const handler = Object.prototype.hasOwnProperty.call(api, method) ? api[method] : undefined
          if (typeof handler !== 'function') {
            writeJson(response, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${method}"` } })
            return
          }
          try {
            const payload = await readJsonBody(request)
            const value = await handler(payload)
            writeJson(response, 200, { ok: true, value: value ?? null })
          } catch (error) {
            if (error instanceof PluginError) {
              writeJson(response, error.status, { ok: false, error: { code: error.code, message: error.message } })
              return
            }
            writeJson(response, 500, {
              ok: false,
              error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
            })
          }
        },
      }),
    'dsh-t3-session-ui: /t3session/api routes',
  )
}

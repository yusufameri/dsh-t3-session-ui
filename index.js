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
import { arch, homedir, hostname, platform, release } from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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
 * Write one JSON response.
 *
 * @param response - Node HTTP response.
 * @param status - HTTP status code.
 * @param body - Serialisable body.
 */
function writeJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
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

// ------------------------------------------------------------------- handlers

/**
 * Build the API handlers bound to one Cordis context.
 *
 * @param ctx - The plugin's Host-side context.
 * @param config - Resolved plugin configuration.
 * @returns a method table addressed by the route.
 */
function buildApi(ctx, config) {
  const hostFacts = () => {
    const raw = attempt(() => hostname()) ?? 'unknown'
    return {
      hostname: raw,
      machineLabel: config.machineLabel !== '' ? config.machineLabel : friendlyMachineLabel(raw),
      machineLabelIsCustom: config.machineLabel !== '',
      platform: attempt(() => platform()),
      arch: attempt(() => arch()),
      release: attempt(() => release()),
      home: attempt(() => homedir()),
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
      return { sessionId, live: false, machine: hostFacts() }
    }

    const header = session.header ?? {}
    const cwd = typeof header.cwd === 'string' ? header.cwd : undefined
    const requestContext = attempt(() => session.requestContext())
    const requestHeader = attempt(() => session.requestHeader())
    const phase = attempt(() => deriveTurnPhase(session))

    const tokens = attempt(() => {
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

    const approval = attempt(() => {
      const service = ctx.get('approval')
      if (service === undefined || typeof service.overrideOf !== 'function') return undefined
      const policy = service.overrideOf(session)
      return policy === undefined ? undefined : { policy }
    })

    const subagents = attempt(() => {
      const service = ctx.get('subagents')
      if (service === undefined || typeof service.listChildren !== 'function') return undefined
      return service.listChildren(sessionId).then((children) => ({
        count: Array.isArray(children) ? children.length : 0,
      }))
    })

    const goal = attempt(() => {
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

    return {
      sessionId,
      live: true,
      machine: hostFacts(),
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
      seq: attempt(() => session.seq),
      turn: phase,
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
    pluginVersion: typeof config?.pluginVersion === 'string' ? config.pluginVersion : '0.1.0',
  }
}

// Pure helpers exported for the package's own tests. They are internal: the
// Loader only consumes `name`, `inject`, and `apply`, and nothing else in DSH
// should depend on these signatures.
export { deriveTurnPhase, friendlyMachineLabel, isTrustedRequest, probeGit, resolveConfig }

/**
 * Mount the Host half: one fenced JSON RPC route on DSH's web server.
 *
 * @param ctx - The plugin's Host-side context.
 * @param config - Loader-provided configuration.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const api = buildApi(ctx, resolved)

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (request, response) => {
          const trustedHosts = ctx.webRuntime?.trustedHosts
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

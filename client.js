/**
 * Client half of the T3 session-context UI.
 *
 * A port of the session-context surfaces from T3 Code
 * (https://github.com/pingdotgg/t3code), by the T3 Code authors under MIT.
 * The information hierarchy — the row hover card, the status ladder, the
 * provider/model row, the context-window ring with its compaction action — is
 * theirs; only the data underneath is DeepSeek Harness's.
 *
 * Every surface reads one per-session context bundle from this package's Host
 * half (`/t3session/api/sessionContext`), which is the only side that can see
 * the machine, the working directory, git, live token pressure, and the
 * approval policy. The seats declare no ordering authority over shipped UI:
 * each one is an additive `list` seat, except the composer's activity seat,
 * which is an empty `single` seat this plugin is the first to occupy.
 *
 * A fact the Host could not read is omitted rather than faked, so a session
 * outside a git work tree simply has no branch row.
 */

window.__ModuleLoader__.load({
  id: 'dsh-t3-session-ui',
  factory(require) {
    const React = require('react')

    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    /** Dictionary namespace owned by this plugin. */
    const NS = 't3SessionUi'

    /** Host RPC route this package's Host half serves. */
    const API = '/t3session/api'

    /** Reuse window for one fetched context bundle, in ms. */
    const CONTEXT_TTL_MS = 5000

    /** Refresh cadence for the composer ring while a turn is running, in ms. */
    const RUNNING_POLL_MS = 2500

    const EN = {
      'row.title': 'Session context',
      'row.machine': 'Machine',
      'row.workspace': 'Workspace',
      'row.branch': 'Branch',
      'row.branchDirty': '{branch} (uncommitted changes)',
      'row.branchDetached': 'detached HEAD',
      'row.worktree': 'Worktree',
      'row.model': 'Model',
      'row.provider': 'Provider',
      'row.preset': 'Preset',
      'row.parent': 'Parent session',
      'row.depth': 'Depth',
      'row.approval': 'Approval',
      'row.subagents': 'Subagents',
      'row.goal': 'Goal',
      'row.context': 'Context',
      'row.error': 'Error occurred',
      'row.offline': 'Not running in this process',
      'status.approval': 'Approval',
      'status.input': 'Awaiting input',
      'status.working': 'Working',
      'status.ready': 'Ready',
      'status.failed': 'Error',
      'status.offline': 'Offline',
      'status.subagents': '{count} subagent',
      'status.subagentsPlural': '{count} subagents',
      'prefs.title': 'Display',
      'prefs.showMachine': 'Machine',
      'prefs.showWorkspace': 'Workspace',
      'prefs.showBranch': 'Branch',
      'prefs.showModel': 'Model',
      'prefs.showPreset': 'Agent preset',
      'prefs.showApproval': 'Approval policy',
      'prefs.showContext': 'Context usage',
      'prefs.machineLabel': 'Machine label',
      'prefs.machineLabelPlaceholder': 'Defaults to this machine’s hostname',
      'prefs.reset': 'Reset',
      'meter.title': 'Context Window',
      'meter.aria': 'Context window, {percent} used',
      'meter.ariaTokens': 'Context window, {tokens} tokens used',
      'meter.loading': 'Reading context…',
      'meter.unavailable': 'This session has no measured context yet.',
      'meter.noMax': 'The provider has not reported a context window size.',
      'meter.baseline': 'Measured from {kind}',
      'meter.compact': 'Compact',
      'meter.compacting': 'Compacting…',
      'meter.compactFailed': 'Compaction failed: {message}',
      'meter.compactUnavailable': 'Compaction is unavailable for this session.',
      'meter.expand': 'Show context details',
      'meter.collapse': 'Hide context details',
      'action.copy': 'Copy session context',
      'action.copied': 'Copied',
      'menu.copyJson': 'Copy session context as JSON',
      'menu.copyBranch': 'Copy branch name',
      'menu.copyCwd': 'Copy working directory',
    }

    const ZH = {
      'row.title': '会话上下文',
      'row.machine': '机器',
      'row.workspace': '工作区',
      'row.branch': '分支',
      'row.branchDirty': '{branch}（有未提交改动）',
      'row.branchDetached': '游离 HEAD',
      'row.worktree': '工作树',
      'row.model': '模型',
      'row.provider': '提供方',
      'row.preset': '预设',
      'row.parent': '父会话',
      'row.depth': '深度',
      'row.approval': '审批',
      'row.subagents': '子代理',
      'row.goal': '目标',
      'row.context': '上下文',
      'row.error': '发生错误',
      'row.offline': '未在当前进程中运行',
      'status.approval': '待审批',
      'status.input': '等待输入',
      'status.working': '运行中',
      'status.ready': '就绪',
      'status.failed': '错误',
      'status.offline': '离线',
      'status.subagents': '{count} 个子代理',
      'status.subagentsPlural': '{count} 个子代理',
      'prefs.title': '显示',
      'prefs.showMachine': '机器',
      'prefs.showWorkspace': '工作区',
      'prefs.showBranch': '分支',
      'prefs.showModel': '模型',
      'prefs.showPreset': '代理预设',
      'prefs.showApproval': '审批策略',
      'prefs.showContext': '上下文用量',
      'prefs.machineLabel': '机器名称',
      'prefs.machineLabelPlaceholder': '默认使用本机主机名',
      'prefs.reset': '重置',
      'meter.title': '上下文窗口',
      'meter.aria': '上下文窗口，已用 {percent}',
      'meter.ariaTokens': '上下文窗口，已用 {tokens} token',
      'meter.loading': '正在读取上下文…',
      'meter.unavailable': '该会话尚无上下文测量。',
      'meter.noMax': '提供方未报告上下文窗口大小。',
      'meter.baseline': '基于 {kind} 测量',
      'meter.compact': '压缩',
      'meter.compacting': '正在压缩…',
      'meter.compactFailed': '压缩失败：{message}',
      'meter.compactUnavailable': '该会话无法压缩。',
      'meter.expand': '展开上下文详情',
      'meter.collapse': '收起上下文详情',
      'action.copy': '复制会话上下文',
      'action.copied': '已复制',
      'menu.copyJson': '复制会话上下文为 JSON',
      'menu.copyBranch': '复制分支名',
      'menu.copyCwd': '复制工作目录',
    }

    // ------------------------------------------------------------- rpc client

    /** Read the `{ok, value}` envelope this package's Host half writes. */
    async function call(method, payload, signal) {
      let response
      try {
        response = await fetch(`${API}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
          signal,
        })
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error))
      }
      const parsed = await response.json().catch(() => null)
      if (!response.ok || parsed === null || parsed.ok !== true) {
        throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`)
      }
      return parsed.value
    }

    // ------------------------------------------------------------ formatting

    /** Compact token counts the way T3 does: exact below 1k, then k, then M. */
    function formatTokens(value) {
      if (!Number.isFinite(value)) return '—'
      if (value < 1000) return String(Math.round(value))
      if (value < 1e6) {
        const thousands = value / 1000
        return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, '') : Math.round(thousands)}k`
      }
      return `${(value / 1e6).toFixed(1)}M`
    }

    /** Percentage label: one decimal below 10%, whole numbers above. */
    function formatPercent(value) {
      if (!Number.isFinite(value)) return null
      if (value < 10) return `${value.toFixed(1).replace(/\.0$/, '')}%`
      return `${Math.round(value)}%`
    }

    /** Tail of a path, for a label that has to fit a sidebar row. */
    function basename(path) {
      if (typeof path !== 'string' || path === '') return undefined
      const parts = path.split('/').filter((part) => part !== '')
      return parts[parts.length - 1]
    }

    /** Fill `{name}` placeholders in a dictionary entry. */
    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
      )
    }

    // ---------------------------------------------------------- preferences

    /** Storage key holding this plugin's display preferences. */
    const PREFS_KEY = 'dsh.t3-session-ui.prefs.v1'

    /** Default display preferences: everything shown, hostname label. */
    const DEFAULT_PREFS = {
      machineLabel: '',
      showMachine: true,
      showWorkspace: true,
      showBranch: true,
      showModel: true,
      showPreset: true,
      showApproval: true,
      showContext: true,
    }

    /**
     * Coerce a stored value into the known preference shape.
     *
     * A preference is user data read from `localStorage`, so it is treated as
     * untrusted: unknown keys are dropped and booleans are type-checked rather
     * than trusted, so a hand-edited store cannot disable a surface by accident.
     *
     * @param raw - Parsed stored value, or undefined.
     * @returns a complete preference record.
     */
    function normalizePrefs(raw) {
      if (raw === null || typeof raw !== 'object') return { ...DEFAULT_PREFS }
      const prefs = { ...DEFAULT_PREFS }
      if (typeof raw.machineLabel === 'string') prefs.machineLabel = raw.machineLabel
      for (const key of Object.keys(DEFAULT_PREFS)) {
        if (key === 'machineLabel') continue
        if (typeof raw[key] === 'boolean') prefs[key] = raw[key]
      }
      return prefs
    }

    /**
     * A tiny observable preference store backed by `localStorage`.
     *
     * Display toggles stay browser-side on purpose: they change only this
     * plugin's rendering, they must work without a Host round trip, and DSH
     * shares one Host across every connected browser.
     *
     * @returns `{ subscribe, get, set, reset }`.
     */
    function createPrefsStore() {
      let prefs = DEFAULT_PREFS
      try {
        const stored = window.localStorage?.getItem(PREFS_KEY)
        if (typeof stored === 'string') prefs = normalizePrefs(JSON.parse(stored))
      } catch {
        // Unreadable or absent storage falls back to the defaults.
      }
      const listeners = new Set()
      const emit = () => {
        for (const listener of [...listeners]) listener()
      }
      const persist = () => {
        try {
          window.localStorage?.setItem(PREFS_KEY, JSON.stringify(prefs))
        } catch {
          // A denied or full store only costs persistence, not rendering.
        }
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        get: () => prefs,
        set(patch) {
          prefs = normalizePrefs({ ...prefs, ...patch })
          persist()
          emit()
        },
        reset() {
          prefs = { ...DEFAULT_PREFS }
          persist()
          emit()
        },
      }
    }

    /** A never-firing subscription, used when no preference store is bound. */
    const NOOP_SUBSCRIBE = () => () => {}

    /** Stable read of the defaults, so a storeless render has a constant snapshot. */
    const readDefaultPrefs = () => DEFAULT_PREFS

    /**
     * Subscribe a surface to the preference store.
     *
     * Tolerates an absent store so a surface renders with the defaults when a
     * seat is mounted without one (which is how the package's tests render).
     *
     * @param store - The preference store, when bound.
     * @returns the current preferences, re-read on every change.
     */
    function usePrefs(store) {
      const subscribe = store === undefined ? NOOP_SUBSCRIBE : store.subscribe
      const read = store === undefined ? readDefaultPrefs : store.get
      return useSyncExternalStore(subscribe, read, read)
    }

    // -------------------------------------------------------- context store

    /**
     * Share one fetched context bundle per session across every seat, so the
     * hover card and the header strip never issue duplicate reads.
     *
     * @param ctx - The plugin's Client context.
     * @returns the store the seats subscribe to.
     */
    function createContextStore(ctx) {
      const entries = new Map()
      const listeners = new Set()

      const emit = () => {
        for (const listener of [...listeners]) listener()
      }

      const subscribe = (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }

      const peek = (sessionId) => (typeof sessionId === 'string' ? entries.get(sessionId) : undefined)

      /**
       * Fetch one session's bundle, reusing a fresh entry unless forced.
       *
       * @param sessionId - Session to read.
       * @param force - Bypass the reuse window (reconnect, compaction, polling).
       */
      const load = async (sessionId, force) => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        const current = entries.get(sessionId)
        if (!force && current !== undefined && (current.pending === true || Date.now() - current.at < CONTEXT_TTL_MS)) return
        entries.set(sessionId, { at: Date.now(), pending: true, value: current?.value, error: undefined })
        emit()
        try {
          const value = await call('sessionContext', { sessionId })
          entries.set(sessionId, { at: Date.now(), pending: false, value, error: undefined })
        } catch (error) {
          entries.set(sessionId, {
            at: Date.now(),
            pending: false,
            value: current?.value,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        emit()
      }

      /** Drop every cached bundle and refetch what is still mounted. */
      const refreshAll = () => {
        for (const sessionId of [...entries.keys()]) void load(sessionId, true)
      }

      ctx.effect(() => ctx.on('connection/reset', refreshAll), 'dsh-t3-session-ui: reconnect refresh')

      return { subscribe, peek, load, refreshAll }
    }

    /**
     * Subscribe one seat to a session's context bundle.
     *
     * @param store - The shared context store.
     * @param sessionId - Session the seat renders.
     * @param pollMs - Optional polling cadence while the entry is loading.
     * @returns the store entry, or undefined before the first fetch resolves.
     */
    function useSessionContext(store, sessionId, pollMs) {
      const read = useCallback(() => store.peek(sessionId), [store, sessionId])
      // The third argument is the server snapshot: the store is shared and
      // synchronous, so the same read is correct under `renderToStaticMarkup`,
      // which the package's tests use.
      const entry = useSyncExternalStore(store.subscribe, read, read)
      useEffect(() => {
        void store.load(sessionId)
      }, [store, sessionId])
      useEffect(() => {
        if (!Number.isFinite(pollMs) || pollMs <= 0) return undefined
        const timer = window.setInterval(() => void store.load(sessionId, true), pollMs)
        return () => window.clearInterval(timer)
      }, [store, sessionId, pollMs])
      return entry
    }

    // -------------------------------------------------------- status ladder

    /**
     * Resolve the status rung for one bundle.
     *
     * The Host resolves the rung, because only it sees the process-local
     * approval and question waterfalls; this function localizes the rung and
     * keeps a turn-phase fallback for a bundle that predates the Host's status
     * field. The ladder is T3 Code's order: pending approval, awaiting input,
     * working, failure, background work, ready.
     *
     * @param bundle - The session context bundle.
     * @param t - Bound translator.
     * @returns `{ tone, label, detail }`.
     */
    function resolveStatus(bundle, t) {
      if (bundle === undefined) return { tone: 'idle', label: '…' }
      const declared = bundle.status?.kind
      if (bundle.live !== true) {
        if (declared === 'working') return { tone: 'working', label: t('status.working') }
        return { tone: 'idle', label: t('status.offline') }
      }
      const kind = declared ?? fallbackStatusKind(bundle)
      if (kind === 'monitoring') {
        const count = Number(bundle.subagents?.count ?? 0)
        return {
          tone: 'monitoring',
          label: fill(t(count === 1 ? 'status.subagents' : 'status.subagentsPlural'), { count }),
          detail: bundle.status?.error,
        }
      }
      return {
        tone: kind === 'offline' ? 'idle' : kind,
        label: t(`status.${kind}`),
        detail: bundle.status?.error ?? bundle.turn?.error,
      }
    }

    /**
     * Derive a rung from the bundle's own fields, for a Host that did not send
     * a resolved status.
     *
     * @param bundle - The session context bundle.
     * @returns the rung kind.
     */
    function fallbackStatusKind(bundle) {
      if (bundle.turn?.phase === 'running') return 'working'
      if (bundle.turn?.phase === 'failed') return 'failed'
      if (Number(bundle.subagents?.count ?? 0) > 0) return 'monitoring'
      return 'ready'
    }

    // ------------------------------------------------------------- fragments

    /** One `icon + value` line, matching T3's hover-card row shape. */
    function ContextRow(props) {
      return h(
        'div',
        { className: 't3s-row' },
        props.icon === undefined ? null : h('span', { className: 't3s-rowIcon', 'aria-hidden': 'true' }, props.icon),
        h('span', { className: 't3s-rowValue', title: props.title ?? props.value }, props.value),
      )
    }

    /** A status dot coloured by the resolved rung. */
    function StatusDot(props) {
      return h('span', { className: `t3s-dot t3s-dot-${props.tone}`, 'aria-hidden': 'true' })
    }

    /** The status pill: dot plus label, used in both the hover card and header. */
    function StatusPill(props) {
      return h(
        'span',
        { className: `t3s-pill t3s-pill-${props.tone}`, title: props.detail ?? props.label },
        h(StatusDot, { tone: props.tone }),
        h('span', { className: 't3s-pillLabel' }, props.label),
      )
    }

    // --------------------------------------------------------- inline icons

    const ICON = {
      machine: h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
        h('rect', { x: 2, y: 3, width: 12, height: 8, rx: 1.5 }),
        h('path', { d: 'M6 13h4M8 11v2' }),
      ),
      branch: h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
        h('circle', { cx: 4.5, cy: 4, r: 1.6 }),
        h('circle', { cx: 4.5, cy: 12, r: 1.6 }),
        h('circle', { cx: 11.5, cy: 6.5, r: 1.6 }),
        h('path', { d: 'M4.5 5.6v4.8M11.5 8.1c0 2-2 2.4-4 2.6' }),
      ),
      worktree: h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
        h('path', { d: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2l1.2 1.6h5.6A1.5 1.5 0 0 1 14 6.1v5.4A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z' }),
      ),
      model: h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
        h('path', { d: 'M8 2.5 13.5 8 8 13.5 2.5 8z' }),
      ),
      provider: h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
        h('circle', { cx: 8, cy: 8, r: 5.2 }),
        h('path', { d: 'M8 2.8v10.4M2.8 8h10.4' }),
      ),
      preset: h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
        h('path', { d: 'M3 4h10M3 8h10M3 12h6' }),
      ),
      lineage: h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
        h('circle', { cx: 5, cy: 5, r: 1.8 }),
        h('circle', { cx: 11, cy: 11, r: 1.8 }),
        h('path', { d: 'M6.8 5h2.7a1.5 1.5 0 0 1 1.5 1.5v2.7' }),
      ),
      approval: h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
        h('path', { d: 'M8 2.5 13 5v3.4c0 2.6-2 4.6-5 5.6-3-1-5-3-5-5.6V5z' }),
      ),
      subagent: h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
        h('circle', { cx: 8, cy: 4, r: 1.7 }),
        h('circle', { cx: 4, cy: 12, r: 1.7 }),
        h('circle', { cx: 12, cy: 12, r: 1.7 }),
        h('path', { d: 'M8 5.7v2.1M4.9 10.6 7 8.6M11.1 10.6 9 8.6' }),
      ),
      goal: h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
        h('circle', { cx: 8, cy: 8, r: 5.2 }),
        h('circle', { cx: 8, cy: 8, r: 1.8 }),
      ),
      context: h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
        h('path', { d: 'M2.5 12.5V9M6 12.5V6M9.5 12.5V8M13 12.5V4' }),
      ),
      alert: h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
        h('circle', { cx: 8, cy: 8, r: 5.6 }),
        h('path', { d: 'M8 5.2v3.6M8 10.9v.1' }),
      ),
      copy: h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
        h('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }),
        h('path', { d: 'M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5V9A1.5 1.5 0 0 0 4 10.5h1' }),
      ),
    }

    // ------------------------------------------------------------- surfaces

    /**
     * `sidebar.session.row.hover` — the T3 hover-card context block.
     *
     * Rendered inside the row's own hover card, between its relative time and
     * its trailing status line, so it inherits that card's chrome.
     */
    function SessionRowHover(props) {
      const { sessionId, store, t } = props
      const entry = useSessionContext(store, sessionId)
      const prefs = usePrefs(props.prefs)
      if (typeof sessionId !== 'string' || sessionId === '') return null
      const bundle = entry?.value
      if (bundle === undefined) return null
      if (bundle.live !== true) {
        return h('div', { className: 't3s-block' }, h(ContextRow, { icon: ICON.alert, value: t('row.offline') }))
      }
      const status = resolveStatus(bundle, t)
      const git = bundle.git
      const branchLabel = git === undefined
        ? undefined
        : git.detached === true
          ? t('row.branchDetached')
          : git.dirty === true
            ? fill(t('row.branchDirty'), { branch: git.branch })
            : git.branch
      const contextLabel = Number.isFinite(bundle.tokens?.usedPercent)
        ? formatPercent(bundle.tokens.usedPercent)
        : Number.isFinite(bundle.tokens?.used)
          ? formatTokens(bundle.tokens.used)
          : undefined
      const rows = [
        !prefs.showMachine || bundle.machine?.machineLabel === undefined
          ? null
          : h(ContextRow, {
              key: 'machine',
              icon: ICON.machine,
              value: prefs.machineLabel !== '' ? prefs.machineLabel : bundle.machine.machineLabel,
            }),
        !prefs.showWorkspace || bundle.cwd === undefined
          ? null
          : h(ContextRow, { key: 'ws', icon: ICON.worktree, value: bundle.workspaceName ?? bundle.cwd, title: bundle.cwd }),
        !prefs.showBranch || branchLabel === undefined
          ? null
          : h(ContextRow, { key: 'branch', icon: ICON.branch, value: branchLabel }),
        git?.worktree === undefined ? null : h(ContextRow, { key: 'wt', icon: ICON.worktree, value: t('row.worktree') }),
        !prefs.showModel || bundle.model === undefined
          ? null
          : h(ContextRow, {
              key: 'model',
              icon: ICON.model,
              value: bundle.provider === undefined ? bundle.model : `${bundle.model} · ${bundle.provider}`,
            }),
        !prefs.showPreset || bundle.preset === undefined
          ? null
          : h(ContextRow, { key: 'preset', icon: ICON.preset, value: bundle.preset }),
        bundle.parentSession === undefined
          ? null
          : h(ContextRow, { key: 'parent', icon: ICON.lineage, value: bundle.parentSession }),
        Number.isFinite(bundle.delegationDepth) && bundle.delegationDepth > 0
          ? h(ContextRow, { key: 'depth', icon: ICON.lineage, value: String(bundle.delegationDepth) })
          : null,
        !prefs.showApproval || bundle.approval?.policy === undefined
          ? null
          : h(ContextRow, { key: 'approval', icon: ICON.approval, value: bundle.approval.policy }),
        !prefs.showContext || contextLabel === undefined
          ? null
          : h(ContextRow, { key: 'ctx', icon: ICON.context, value: contextLabel }),
      ].filter((row) => row !== null)
      return h(
        'div',
        { className: 't3s-block' },
        h('div', { className: 't3s-blockHead' }, h(StatusPill, { tone: status.tone, label: status.label, detail: status.detail })),
        h('div', { className: 't3s-rowsWrap' }, rows),
        bundle.turn?.phase === 'failed' && bundle.turn?.error !== undefined
          ? h('div', { className: 't3s-errorRow' }, ICON.alert, h('span', { className: 't3s-errorText' }, t('row.error')))
          : null,
      )
    }

    /** `sidebar.session.row.leading` — the provider/model chip, T3's badge cell. */
    function SessionRowLeading(props) {
      const { sessionId, store, t } = props
      const entry = useSessionContext(store, sessionId)
      if (typeof sessionId !== 'string' || sessionId === '') return null
      const bundle = entry?.value
      if (bundle === undefined || bundle.live !== true) return null
      const status = resolveStatus(bundle, t)
      const label = bundle.model ?? bundle.provider
      if (label === undefined) return h(StatusDot, { tone: status.tone })
      return h(
        'span',
        { className: 't3s-chip', title: `${label}${bundle.provider === undefined ? '' : ` · ${bundle.provider}`}` },
        h(StatusDot, { tone: status.tone }),
        h('span', { className: 't3s-chipLabel' }, label),
      )
    }

    /**
     * `conversation.session.header.utilities` — the per-session context strip.
     *
     * Carries the facts T3 splits between its chat header and its branch
     * toolbar: model, branch, working directory, approval policy, and the
     * lineage of a forked or delegated session.
     */
    function HeaderContextStrip(props) {
      const { sessionId, store, t } = props
      const entry = useSessionContext(store, sessionId)
      const prefs = usePrefs(props.prefs)
      const bundle = entry?.value
      if (typeof sessionId !== 'string' || sessionId === '') return null
      if (bundle === undefined || bundle.live !== true) return null
      const status = resolveStatus(bundle, t)
      const git = bundle.git
      // The header is a narrow strip that already shares its row with other
      // utilities, so it carries only what a reader needs at a glance. The
      // workspace, agent preset, and delegation depth stay in the hover card
      // and the lineage breadcrumb, which have room for them.
      const stripContextLabel = Number.isFinite(bundle.tokens?.usedPercent)
        ? formatPercent(bundle.tokens.usedPercent)
        : undefined
      const items = [
        !prefs.showModel || bundle.model === undefined
          ? null
          : { key: 'model', icon: ICON.model, text: bundle.model, title: t('row.model') },
        !prefs.showBranch || git?.branch === undefined
          ? null
          : { key: 'branch', icon: ICON.branch, text: git.branch, title: git.dirty === true ? t('row.branchDirty') : t('row.branch') },
        !prefs.showApproval || bundle.approval?.policy === undefined
          ? null
          : { key: 'approval', icon: ICON.approval, text: bundle.approval.policy, title: t('row.approval') },
        !prefs.showContext || stripContextLabel === undefined
          ? null
          : { key: 'ctx', icon: ICON.context, text: stripContextLabel, title: t('row.context') },
        Number.isFinite(bundle.subagents?.count) && bundle.subagents.count > 0
          ? { key: 'subagents', icon: ICON.subagent, text: String(bundle.subagents.count), title: t('row.subagents') }
          : null,
      ].filter((item) => item !== null)
      if (items.length === 0) return null
      return h(
        'span',
        { className: 't3s-strip' },
        h(StatusPill, { tone: status.tone, label: status.label, detail: status.detail }),
        items.map((item) =>
          h(
            'span',
            { key: item.key, className: 't3s-stripItem', title: item.title },
            h('span', { className: 't3s-stripIcon', 'aria-hidden': 'true' }, item.icon),
            h('span', { className: 't3s-stripText' }, item.text),
          ),
        ),
      )
    }

    /**
     * `conversation.input.activity` — T3's context-window ring.
     *
     * The ring reports how full the model's context window is and turns red
     * past 90%; opening it expands across the composer's toolbar (the seat's
     * `onActiveChange` yields the width) and offers the compaction action,
     * which calls DSH's own `/compact` rather than reimplementing it.
     */
    function ContextMeter(props) {
      const { sessionId, store, t, onActiveChange } = props
      const [open, setOpen] = useState(false)
      const [compacting, setCompacting] = useState(false)
      const [compactError, setCompactError] = useState(undefined)
      const entry = useSessionContext(store, sessionId)
      const bundle = entry?.value
      const usedPercent = bundle?.tokens?.usedPercent
      const used = bundle?.tokens?.used
      const max = bundle?.tokens?.max
      const running = bundle?.turn?.phase === 'running'

      useEffect(() => {
        if (typeof onActiveChange === 'function') onActiveChange(open)
        return () => {
          if (typeof onActiveChange === 'function') onActiveChange(false)
        }
      }, [open, onActiveChange])

      const onCompact = useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        setCompacting(true)
        setCompactError(undefined)
        try {
          await call('compact', { sessionId })
          await store.load(sessionId, true)
        } catch (error) {
          setCompactError(error instanceof Error ? error.message : String(error))
        } finally {
          setCompacting(false)
        }
      }, [sessionId, store])

      if (typeof sessionId !== 'string' || sessionId === '') return null

      const clamped = Math.max(0, Math.min(100, Number.isFinite(usedPercent) ? usedPercent : 0))
      const radius = 9.75
      const circumference = 2 * Math.PI * radius
      const dashOffset = circumference * (1 - clamped / 100)
      const overloaded = clamped > 90
      const label = formatPercent(usedPercent)
      const aria = label !== null
        ? fill(t('meter.aria'), { percent: label })
        : Number.isFinite(used)
          ? fill(t('meter.ariaTokens'), { tokens: formatTokens(used) })
          : t('meter.loading')

      const ring = h(
        'span',
        { className: 't3s-ringWrap' },
        h(
          'svg',
          { viewBox: '0 0 24 24', className: 't3s-ring', 'aria-hidden': 'true' },
          h('circle', { cx: 12, cy: 12, r: radius, fill: 'none', stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 3 }),
          h('circle', {
            cx: 12,
            cy: 12,
            r: radius,
            fill: 'none',
            stroke: overloaded ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-brand-primary)',
            strokeWidth: 3,
            strokeLinecap: 'round',
            strokeDasharray: circumference,
            strokeDashoffset: dashOffset,
            transform: 'rotate(-90 12 12)',
          }),
        ),
      )

      return h(
        'span',
        { className: 't3s-meter' },
        h(
          'button',
          {
            type: 'button',
            className: 't3s-meterButton',
            'aria-label': aria,
            'aria-expanded': open,
            title: label === null ? aria : `${label}${Number.isFinite(max) ? ` · ${formatTokens(used)}/${formatTokens(max)}` : ''}`,
            onClick: () => setOpen((value) => !value),
          },
          ring,
          h('span', { className: 't3s-meterText' }, label ?? (Number.isFinite(used) ? formatTokens(used) : '—')),
        ),
        open
          ? h(
              'span',
              { className: 't3s-panel', role: 'dialog', 'aria-label': t('meter.title') },
              h(
                'span',
                { className: 't3s-panelHead' },
                h('span', { className: 't3s-panelTitle' }, t('meter.title')),
                label === null
                  ? null
                  : h(
                      'span',
                      { className: 't3s-panelMeta' },
                      label,
                      Number.isFinite(max) ? ` · ${formatTokens(used)}/${formatTokens(max)}` : '',
                    ),
              ),
              bundle === undefined
                ? h('span', { className: 't3s-panelNote' }, t('meter.loading'))
                : Number.isFinite(used) && Number.isFinite(max)
                  ? h(
                      'span',
                      { className: 't3s-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(clamped) },
                      h('span', { className: 't3s-barFill', style: { width: `${clamped}%` } }),
                    )
                  : h('span', { className: 't3s-panelNote' }, t('meter.noMax')),
              bundle?.tokens?.baselineKind === undefined
                ? null
                : h('span', { className: 't3s-panelNote' }, fill(t('meter.baseline'), { kind: bundle.tokens.baselineKind })),
              h(
                'span',
                { className: 't3s-panelActions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 't3s-action',
                    disabled: compacting || bundle?.live !== true,
                    onClick: onCompact,
                  },
                  compacting ? t('meter.compacting') : t('meter.compact'),
                ),
              ),
              compactError === undefined
                ? null
                : h('span', { className: 't3s-panelError' }, fill(t('meter.compactFailed'), { message: compactError })),
              h(PrefsPanel, { t, prefs: props.prefs }),
            )
          : null,
      )
    }

    /** `conversation.session.header.actions` — copy the session's context. */
    function CopyContextAction(props) {
      const { sessionId, store, t } = props
      const [copied, setCopied] = useState(false)
      const entry = useSessionContext(store, sessionId)
      if (typeof sessionId !== 'string' || sessionId === '') return null
      const onClick = async () => {
        const bundle = entry?.value ?? (await call('sessionContext', { sessionId }).catch(() => undefined))
        if (bundle === undefined) return
        try {
          await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2))
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1400)
        } catch {
          /* clipboard denied: leave the label unchanged */
        }
      }
      return h(
        'button',
        { type: 'button', className: 't3s-iconButton', title: t('action.copy'), 'aria-label': t('action.copy'), onClick },
        ICON.copy,
        copied ? h('span', { className: 't3s-iconButtonText' }, t('action.copied')) : null,
      )
    }

    /**
     * `sidebar.workspaces.session.row.action` — the row's hover strip action.
     *
     * One icon button (the seat renders one button and owns its action), which
     * copies the whole context bundle. It sits with the shipped `archive` and
     * `pin` buttons and needs no propagation handling: clicks inside that strip
     * stay in the strip.
     */
    function RowContextAction(props) {
      const { sessionId, store, t } = props
      const [copied, setCopied] = useState(false)
      const entry = useSessionContext(store, sessionId)
      if (typeof sessionId !== 'string' || sessionId === '') return null
      const onClick = async () => {
        const bundle = entry?.value ?? (await call('sessionContext', { sessionId }).catch(() => undefined))
        if (bundle === undefined) return
        try {
          await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2))
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1400)
        } catch {
          /* clipboard denied: leave the button unchanged */
        }
      }
      return h(
        'button',
        {
          type: 'button',
          className: `t3s-iconButton${copied ? ' t3s-iconButtonDone' : ''}`,
          title: copied ? t('action.copied') : t('action.copy'),
          'aria-label': t('action.copy'),
          onClick,
        },
        ICON.copy,
      )
    }

    /**
     * `conversation.session.header.lineage` — T3 Code's richer breadcrumb.
     *
     * The seat exists to *replace* one Session breadcrumb title, and it hands
     * the occupant exactly what the shipped renderer needs: the display title
     * and an optional navigate callback. This renderer therefore reproduces the
     * title faithfully (as a button when navigation is offered, as text
     * otherwise) and only adds lineage detail — parent session, agent preset,
     * delegation depth — beside it when the bundle carries any.
     */
    function HeaderLineage(props) {
      const { lineageSessionId, displayTitle, openTitle, store, t } = props
      const entry = useSessionContext(store, lineageSessionId)
      const bundle = entry?.value
      const title =
        typeof openTitle === 'function'
          ? h('button', { type: 'button', className: 't3s-lineageTitleButton', onClick: openTitle }, displayTitle)
          : h('span', { className: 't3s-lineageTitle' }, displayTitle)
      const chips = []
      if (bundle?.parentSession !== undefined) {
        chips.push({ key: 'parent', icon: ICON.lineage, text: bundle.parentSession, title: t('row.parent') })
      }
      if (bundle?.preset !== undefined) {
        chips.push({ key: 'preset', icon: ICON.preset, text: bundle.preset, title: t('row.preset') })
      }
      if (Number.isFinite(bundle?.delegationDepth) && bundle.delegationDepth > 0) {
        chips.push({ key: 'depth', icon: ICON.lineage, text: `d${bundle.delegationDepth}`, title: t('row.depth') })
      }
      if (displayTitle === undefined && chips.length === 0) return null
      return h(
        'span',
        { className: 't3s-lineage' },
        title,
        chips.length === 0
          ? null
          : h(
              'span',
              { className: 't3s-strip t3s-lineageChips' },
              chips.map((chip) =>
                h(
                  'span',
                  { key: chip.key, className: 't3s-stripItem', title: chip.title },
                  h('span', { className: 't3s-stripIcon', 'aria-hidden': 'true' }, chip.icon),
                  h('span', { className: 't3s-stripText' }, chip.text),
                ),
              ),
            ),
      )
    }

    /** One labelled checkbox row in the meter's display panel. */
    function PrefToggle(props) {
      return h(
        'label',
        { className: 't3s-prefRow' },
        h('input', {
          type: 'checkbox',
          checked: props.checked,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        h('span', { className: 't3s-prefLabel' }, props.label),
      )
    }

    /**
     * The display preferences panel: which facts the surfaces report, and an
     * optional machine-label override that wins over the Host's prettified
     * hostname.
     */
    function PrefsPanel(props) {
      const { t, prefs } = props
      const value = usePrefs(prefs)
      const set = useCallback((patch) => prefs?.set(patch), [prefs])
      const toggleKeys = ['showMachine', 'showWorkspace', 'showBranch', 'showModel', 'showPreset', 'showApproval', 'showContext']
      return h(
        'span',
        { className: 't3s-prefs' },
        h(
          'span',
          { className: 't3s-panelHead' },
          h('span', { className: 't3s-panelTitle' }, t('prefs.title')),
          h(
            'button',
            { type: 'button', className: 't3s-linkButton', onClick: () => prefs?.reset() },
            t('prefs.reset'),
          ),
        ),
        toggleKeys.map((key) =>
          h(PrefToggle, {
            key,
            checked: value[key],
            label: t(`prefs.${key}`),
            onChange: (next) => set({ [key]: next }),
          }),
        ),
        h('input', {
          type: 'text',
          className: 't3s-prefInput',
          value: value.machineLabel,
          placeholder: t('prefs.machineLabelPlaceholder'),
          'aria-label': t('prefs.machineLabel'),
          onChange: (event) => set({ machineLabel: event.target.value }),
        }),
      )
    }
    /**
     * `sidebar.workspaces.session.menu.item` — per-session context actions,
     * the DSH analogue of T3's right-click thread menu entries.
     */
    function makeMenuItems(store) {
      return function SessionMenuItems(props) {
        const { sessionId, t } = props
        const entry = useSessionContext(store, sessionId)
        const bundle = entry?.value
        const write = useCallback(
          async (text) => {
            try {
              await navigator.clipboard.writeText(text)
            } catch {
              /* clipboard denied */
            }
          },
          [],
        )
        if (typeof sessionId !== 'string' || sessionId === '') return null
        const items = [
          h(
            'button',
            { key: 'json', type: 'button', className: 't3s-menuItem', onClick: () => void write(JSON.stringify(bundle ?? { sessionId }, null, 2)) },
            t('menu.copyJson'),
          ),
        ]
        if (bundle?.git?.branch !== undefined) {
          items.push(
            h(
              'button',
              { key: 'branch', type: 'button', className: 't3s-menuItem', onClick: () => void write(bundle.git.branch) },
              t('menu.copyBranch'),
            ),
          )
        }
        if (bundle?.cwd !== undefined) {
          items.push(
            h(
              'button',
              { key: 'cwd', type: 'button', className: 't3s-menuItem', onClick: () => void write(bundle.cwd) },
              t('menu.copyCwd'),
            ),
          )
        }
        return h('span', { className: 't3s-menu' }, items)
      }
    }

    // -------------------------------------------------------------- stylesheet

    const CSS = `
.t3s-block { display: flex; flex-direction: column; gap: 6px; font-size: 12px; line-height: 1.35; max-width: 320px; }
.t3s-blockHead { display: flex; align-items: center; gap: 6px; }
.t3s-rowsWrap { display: grid; gap: 4px; }
.t3s-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.t3s-rowIcon { display: inline-flex; flex: 0 0 auto; color: var(--dsw-alias-label-secondary); }
.t3s-rowValue { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.t3s-errorRow { display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-state-error-primary); }
.t3s-errorText { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.t3s-dot { width: 7px; height: 7px; border-radius: 999px; flex: 0 0 auto; background: var(--dsw-alias-state-idle-primary); }
.t3s-dot-working { background: var(--dsw-alias-brand-primary); animation: t3s-pulse 1.4s ease-in-out infinite; }
.t3s-dot-monitoring { background: var(--dsw-alias-label-secondary); }
.t3s-dot-ready { background: var(--dsw-alias-state-success-primary); }
.t3s-dot-failed { background: var(--dsw-alias-state-error-primary); }
.t3s-dot-idle { background: var(--dsw-alias-state-idle-primary); }
/* T3 ranks these two above Working and tints them distinctly: a pending
   approval is a warning, an awaiting-input prompt is an action request. */
.t3s-dot-approval { background: var(--dsw-alias-state-warn-primary); }
.t3s-dot-input { background: var(--dsw-alias-brand-primary); }
@keyframes t3s-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .t3s-dot-working { animation: none; } }

.t3s-pill { display: inline-flex; align-items: center; gap: 6px; padding: 1px 8px 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; }
.t3s-pillLabel { white-space: nowrap; }
.t3s-pill-failed { color: var(--dsw-alias-state-error-primary); }
.t3s-pill-working { color: var(--dsw-alias-brand-primary); }
.t3s-pill-ready { color: var(--dsw-alias-state-success-primary); }
.t3s-pill-approval { color: var(--dsw-alias-state-warn-primary); }
.t3s-pill-input { color: var(--dsw-alias-brand-primary); }

.t3s-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.t3s-chipLabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.t3s-strip { display: inline-flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; overflow: hidden; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.t3s-stripItem { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 4px; }
.t3s-stripIcon { display: inline-flex; flex: 0 0 auto; color: var(--dsw-alias-label-secondary); opacity: .8; }
.t3s-stripText { flex: 0 0 auto; max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.t3s-meter { position: relative; display: inline-flex; align-items: center; }
.t3s-meterButton { display: inline-flex; align-items: center; gap: 5px; padding: 2px 6px; border: 0; border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; font-size: 11px; }
.t3s-meterButton:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.t3s-meterButton:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.t3s-ringWrap { display: inline-flex; width: 18px; height: 18px; }
.t3s-ring { width: 18px; height: 18px; display: block; }
.t3s-meterText { font-variant-numeric: tabular-nums; }

.t3s-panel { position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 1200; display: flex; flex-direction: column; gap: 7px; width: 248px; padding: 10px 11px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-secondary); font-size: 11px; text-align: left; }
.t3s-panelHead { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.t3s-panelTitle { font-weight: 600; color: var(--dsw-alias-label-primary); }
.t3s-panelMeta { font-variant-numeric: tabular-nums; }
.t3s-panelNote { color: var(--dsw-alias-label-secondary); opacity: .85; }
.t3s-panelError { color: var(--dsw-alias-state-error-primary); }
.t3s-bar { display: block; height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.t3s-barFill { display: block; height: 100%; background: var(--dsw-alias-brand-primary); transition: width .4s ease-out; }
@media (prefers-reduced-motion: reduce) { .t3s-barFill { transition: none; } }
.t3s-panelActions { display: flex; justify-content: flex-end; }
.t3s-action { padding: 3px 10px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; font: inherit; font-size: 11px; }
.t3s-action:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.t3s-action:disabled { opacity: .55; cursor: default; }

.t3s-iconButton { display: inline-flex; align-items: center; gap: 4px; padding: 3px 6px; border: 0; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; font-size: 11px; }
.t3s-iconButton:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.t3s-iconButtonText { white-space: nowrap; }

.t3s-menu { display: flex; flex-direction: column; }
.t3s-menuItem { display: block; width: 100%; padding: 6px 10px; border: 0; background: transparent; color: var(--dsw-alias-label-primary); text-align: left; cursor: pointer; font: inherit; font-size: 12px; border-radius: 6px; }
.t3s-menuItem:hover { background: var(--dsw-alias-bg-layer-2); }

.t3s-iconButtonDone { color: var(--dsw-alias-state-success-primary); }

.t3s-lineage { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.t3s-lineageTitle { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t3s-lineageTitleButton { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.t3s-lineageTitleButton:hover { text-decoration: underline; }
.t3s-lineageChips { flex: 0 0 auto; }

.t3s-prefs { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 8px; margin-top: 2px; }
.t3s-prefRow { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.t3s-prefRow input { accent-color: var(--dsw-alias-brand-primary); }
.t3s-prefLabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t3s-prefInput { width: 100%; padding: 3px 6px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 11px; }
.t3s-linkButton { padding: 0; border: 0; background: transparent; color: var(--dsw-alias-brand-primary); font: inherit; font-size: 11px; cursor: pointer; }
`

    // ------------------------------------------------------------------ apply

    /**
     * Required client services: the seat registry and the dictionary registry.
     * Every fact comes from this package's own Host route, so no other business
     * Service is a dependency.
     */
    const inject = ['slots', 'locale']

    /**
     * Bind a surface to the plugin's dictionary, shared store, and preferences.
     *
     * @param Component - The surface to bind.
     * @param ctx - The plugin's Client context.
     * @param store - The shared session-context store.
     * @param prefs - The preference store.
     * @returns a component receiving `t`, `store`, and `prefs`.
     */
    function bound(Component, ctx, store, prefs) {
      return function BoundSurface(props) {
        const [, force] = useState(0)
        useEffect(() => ctx.on('locale/change', () => force((value) => value + 1)), [ctx])
        const t = ctx.locale.bind(NS)
        return h(Component, Object.assign({}, props, { t, store, prefs }))
      }
    }

    /**
     * Client plugin body: register the dictionaries, one stylesheet, and the
     * six session-context surfaces.
     *
     * @param ctx - The plugin's Client context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'dsh-t3-session-ui: dictionaries')
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.t3SessionUi = ''
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'dsh-t3-session-ui: styles')

      const store = createContextStore(ctx)
      const prefs = createPrefsStore()

      // Additive seats: each registration names its own id, so it sits beside
      // the shipped entries instead of replacing one.
      ctx.slots.inject('sidebar.session.row.hover', () =>
        ctx.slots.register({ name: 'sidebar.session.row.hover', id: 't3s-hover', order: 20, locale: NS }, bound(SessionRowHover, ctx, store, prefs)),
      )
      ctx.slots.inject('sidebar.session.row.leading', () =>
        ctx.slots.register({ name: 'sidebar.session.row.leading', id: 't3s-leading', order: 20, locale: NS }, bound(SessionRowLeading, ctx, store, prefs)),
      )
      ctx.slots.inject('sidebar.workspaces.session.row.action', () =>
        ctx.slots.register(
          { name: 'sidebar.workspaces.session.row.action', id: 't3s-row-copy', order: 50, locale: NS },
          bound(RowContextAction, ctx, store, prefs),
        ),
      )
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register({ name: 'conversation.session.header.utilities', id: 't3s-strip', order: 20, locale: NS }, bound(HeaderContextStrip, ctx, store, prefs)),
      )
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register({ name: 'conversation.session.header.actions', id: 't3s-copy', order: 20, locale: NS }, bound(CopyContextAction, ctx, store, prefs)),
      )
      // A `single` seat whose documented purpose is to REPLACE one breadcrumb
      // title, so it is occupied at priority -1; the renderer reproduces the
      // shipped title from the props it is handed.
      ctx.slots.inject('conversation.session.header.lineage', () =>
        ctx.slots.register({ name: 'conversation.session.header.lineage', priority: -1, locale: NS }, bound(HeaderLineage, ctx, store, prefs)),
      )
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 't3s-menu', order: 20, label: 'Session context', locale: NS }, bound(makeMenuItems(store), ctx, store, prefs)),
      )
      // The composer's activity seat is empty in a stock DSH, so the ring adds
      // rather than replaces. The seat yields composer width while open.
      ctx.slots.inject('conversation.input.activity', () =>
        ctx.slots.register({ name: 'conversation.input.activity', priority: 0, locale: NS }, bound(ContextMeter, ctx, store, prefs)),
      )
    }

    // Internal surface for this package's own tests: the Loader only consumes
    // `inject` and `apply`, and nothing in DSH should depend on these names.
    const __internals = {
      components: {
        SessionRowHover,
        SessionRowLeading,
        HeaderContextStrip,
        ContextMeter,
        CopyContextAction,
        RowContextAction,
        HeaderLineage,
        PrefsPanel,
      },
      createContextStore,
      createPrefsStore,
      normalizePrefs,
      makeMenuItems,
      resolveStatus,
      fallbackStatusKind,
      formatTokens,
      formatPercent,
      basename,
      fill,
      dictionaries: { en: EN, zh: ZH },
      defaultPrefs: DEFAULT_PREFS,
    }

    return { inject, apply, __internals }
  },
})

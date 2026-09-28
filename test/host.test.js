/**
 * Host-half logic tests.
 *
 * These exercise the parts of the Host half that can be checked outside a live
 * DSH process: the machine-label heuristic, the git probe (against real
 * temporary repositories), the turn-phase derivation, the request fence, and
 * configuration defaults.
 *
 * Run with: node --test test/
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import {
  deriveTurnPhase,
  friendlyMachineLabel,
  isTrustedRequest,
  probeGit,
  resolveConfig,
} from '../index.js'

/** Temporary directories created by this suite, removed on exit. */
const scratch = []

/** Create a temporary directory that the suite cleans up. */
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/** Run git in one directory, returning trimmed stdout. */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** Initialise a repository with one commit, on a known branch. */
function initRepo(dir, branch = 'main') {
  git(dir, ['init', '-q', '-b', branch])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'init'])
}

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

describe('friendlyMachineLabel', () => {
  it("turns a hyphenated hostname into a possessive label", () => {
    assert.equal(friendlyMachineLabel('Shimas-MacBook-Pro.local'), "Shimas's MacBook Pro")
  })

  it('keeps an all-caps word intact', () => {
    assert.equal(friendlyMachineLabel('build-XL-runner'), "build's XL Runner")
  })

  it('returns a single-word hostname unchanged', () => {
    assert.equal(friendlyMachineLabel('buildbox'), 'buildbox')
  })

  it('handles a bare name with a domain suffix', () => {
    assert.equal(friendlyMachineLabel('yusufs-mac.local'), "yusufs's Mac")
  })
})

/** The version this package actually ships, so the assertion cannot go stale. */
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version

describe('resolveConfig', () => {
  it('applies defaults when nothing is configured', () => {
    assert.deepEqual(resolveConfig(undefined), { machineLabel: '', pluginVersion: PACKAGE_VERSION })
  })

  it('reports the package version rather than a hardcoded literal', () => {
    assert.match(resolveConfig(undefined).pluginVersion, /^\d+\.\d+\.\d+/)
  })

  it('honours an explicit machine label and trims it', () => {
    const resolved = resolveConfig({ machineLabel: "  Shima's MacBook Pro  ", pluginVersion: '9.9.9' })
    assert.equal(resolved.machineLabel, "Shima's MacBook Pro")
    assert.equal(resolved.pluginVersion, '9.9.9')
  })

  it('treats a whitespace-only label as unset', () => {
    assert.equal(resolveConfig({ machineLabel: '   ' }).machineLabel, '')
  })
})

describe('deriveTurnPhase', () => {
  /** Build a session stand-in whose snapshotEvents yields the given events. */
  const sessionWith = (events) => ({ snapshotEvents: () => events })

  it('reports idle for a session with no turns', () => {
    assert.deepEqual(deriveTurnPhase(sessionWith([])), { phase: 'idle', error: undefined })
  })

  it('reports running while a turn is open', () => {
    const events = [{ type: 'turn/start', data: { turn: 1 } }]
    assert.deepEqual(deriveTurnPhase(sessionWith(events)), { phase: 'running', error: undefined })
  })

  it('reports idle after a completed turn', () => {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    assert.deepEqual(deriveTurnPhase(sessionWith(events)), { phase: 'idle', error: undefined })
  })

  it('reports failed with the error message after an errored turn', () => {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } },
    ]
    assert.deepEqual(deriveTurnPhase(sessionWith(events)), { phase: 'failed', error: 'boom' })
  })

  it('reports failed for an interrupted turn', () => {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } },
    ]
    assert.equal(deriveTurnPhase(sessionWith(events)).phase, 'failed')
  })

  it('lets a later successful turn clear an earlier failure', () => {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    assert.deepEqual(deriveTurnPhase(sessionWith(events)), { phase: 'idle', error: undefined })
  })

  it('treats an open turn as running even after an earlier failure', () => {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } },
      { type: 'turn/start', data: { turn: 2 } },
    ]
    assert.deepEqual(deriveTurnPhase(sessionWith(events)), { phase: 'running', error: undefined })
  })
})

describe('isTrustedRequest', () => {
  const request = (headers) => ({ headers })

  it('accepts a loopback Host with no Origin', () => {
    assert.equal(isTrustedRequest(request({ host: '127.0.0.1:19387' }), []), true)
  })

  it('accepts localhost', () => {
    assert.equal(isTrustedRequest(request({ host: 'localhost:19387' }), []), true)
  })

  it('rejects a missing Host header', () => {
    assert.equal(isTrustedRequest(request({}), []), false)
  })

  it('rejects a non-loopback Host that is not declared trusted', () => {
    assert.equal(isTrustedRequest(request({ host: 'evil.example.com' }), []), false)
  })

  it('accepts a non-loopback Host that the deployment declares trusted', () => {
    assert.equal(isTrustedRequest(request({ host: 'box.tailnet.ts.net:19387' }), ['box.tailnet.ts.net:19387']), true)
  })

  it('rejects a cross-site browser marker', () => {
    assert.equal(isTrustedRequest(request({ host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' }), []), false)
  })

  it('rejects a mismatched Origin', () => {
    assert.equal(
      isTrustedRequest(request({ host: '127.0.0.1:19387', origin: 'https://evil.example.com' }), []),
      false,
    )
  })

  it('accepts a matching Origin', () => {
    assert.equal(isTrustedRequest(request({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' }), []), true)
  })
})

describe('probeGit', () => {
  it('returns undefined outside a work tree', async () => {
    assert.equal(await probeGit(tempDir('t3s-norepo-')), undefined)
  })

  it('returns undefined for an empty or non-string directory', async () => {
    assert.equal(await probeGit(''), undefined)
    assert.equal(await probeGit(undefined), undefined)
  })

  it('reports a clean checkout', async () => {
    const dir = tempDir('t3s-clean-')
    initRepo(dir, 'main')
    const result = await probeGit(dir)
    assert.equal(result.branch, 'main')
    assert.equal(result.dirty, false)
    assert.equal(result.detached, false)
    // git reports the canonical path, so compare against the resolved temp dir
    // (on macOS /var is a symlink to /private/var).
    assert.equal(result.root, realpathSync(dir))
    assert.equal(result.worktree, undefined)
  })

  it('reports an uncommitted change as dirty', async () => {
    const dir = tempDir('t3s-dirty-')
    initRepo(dir, 'main')
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
    const result = await probeGit(dir)
    assert.equal(result.dirty, true)
    assert.equal(result.branch, 'main')
  })

  it('ignores untracked files when deciding dirty', async () => {
    const dir = tempDir('t3s-untracked-')
    initRepo(dir, 'main')
    writeFileSync(join(dir, 'brand-new.txt'), 'new\n')
    const result = await probeGit(dir)
    assert.equal(result.dirty, false)
  })

  it('reports a detached HEAD', async () => {
    const dir = tempDir('t3s-detached-')
    initRepo(dir, 'main')
    const head = git(dir, ['rev-parse', 'HEAD'])
    git(dir, ['checkout', '-q', head])
    const result = await probeGit(dir)
    assert.equal(result.detached, true)
    assert.equal(result.branch, 'HEAD')
  })

  it('marks a linked worktree', async () => {
    const dir = tempDir('t3s-main-')
    const worktreeParent = tempDir('t3s-wt-')
    initRepo(dir, 'main')
    const linked = join(worktreeParent, 'linked')
    git(dir, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const result = await probeGit(linked)
    assert.equal(result.branch, 'feature')
    assert.equal(result.worktree, linked)
  })

  it('does not mark the primary checkout as a linked worktree', async () => {
    const dir = tempDir('t3s-primary-')
    initRepo(dir, 'main')
    const result = await probeGit(dir)
    assert.equal(result.worktree, undefined)
  })
})

# dsh-t3-session-ui

T3 Code's session-context UX for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
a session-row context block, provider/model chip, a status pill, a per-session
header context strip, and a context-window meter that can compact.

## Credit

The information hierarchy this plugin implements is [T3 Code](https://github.com/pingdotgg/t3code)'s:
the session-row hover card, the status ladder, the provider/model row, and the
context-window ring with its compaction action are all theirs. T3 Code is
[open source under MIT](https://github.com/pingdotgg/t3code/blob/main/LICENSE);
this port keeps the same shape and swaps the data underneath for DeepSeek
Harness's. Please support the original project.

## What it adds

Every surface reads one per-session context bundle from this package's own Host
half. A fact the Host could not read is **omitted rather than faked**, so a
session outside a git work tree simply has no branch row.

| Surface | Seat | Shows |
|---|---|---|
| Row hover card | `sidebar.session.row.hover` | Status, machine, workspace, branch (+ dirty), worktree, model · provider, agent preset, parent session, approval policy, context usage, and the error line |
| Row chip | `sidebar.session.row.leading` | The model as the row's leading cell, with a status dot |
| Header strip | `conversation.session.header.utilities` | Status, model, branch, workspace, approval policy, subagent count, preset, delegation depth |
| Context ring | `conversation.input.activity` | Context-window percentage as a ring (red past 90%) that expands into a panel with token counts, a progress bar, and a **Compact** button |
| Copy action | `conversation.session.header.actions` | Copy the whole context bundle as JSON |
| Row menu items | `sidebar.workspaces.session.menu.item` | Copy context as JSON, copy branch name, copy working directory |

The context ring occupies `conversation.input.activity`, which is **empty in a
stock DSH** — it adds a control rather than replacing a shipped one. It expands
across the composer's toolbar while open, using the seat's `onActiveChange`
handoff. The **Compact** button runs DSH's own `/compact` command; this plugin
never reimplements compaction.

## Install

```sh
dsh plugin --profile desktop add dsh-t3-session-ui
```

Or from a checkout, which needs no build step:

```sh
dsh plugin --profile desktop add /path/to/dsh-t3-session-ui
```

Removing the bundle unregisters every seat and restores the previous composer
toolbar with no residue.

## How it works

The facts this UI shows are not reachable from the browser — the machine
identity is a `node:os` call, and `sessions`, `tokenMeter`, `approval`, and
`compaction` carry no `@Remote` face, so a Client half cannot call them through
`ctx.remote`. The Host half therefore serves one fenced JSON RPC route:

```
POST /t3session/api/hostFacts        -> machine identity, no session needed
POST /t3session/api/sessionContext   -> { sessionId } -> the context bundle
POST /t3session/api/compact          -> { sessionId } -> runs /compact
```

The route is fenced to loopback (plus any authority the deployment declares
trusted), rejects cross-site browser markers, and requires a matching `Origin`
when one is present. A browser page therefore reaches it with a plain relative
`fetch`, the same bridge `dsh-better-sidebar` and `@michengai/dsh-codex-ui` use.

Where each fact comes from:

| Fact | Source |
|---|---|
| Machine label | `os.hostname()`, prettified (`Shimas-MacBook-Pro.local` → `Shima's MacBook Pro`), overridable by config |
| Working directory, preset, parent session, delegation depth | `Session.header` |
| Provider, model, context-window size | `Session.requestContext()` |
| Branch, dirty state, worktree | `git` run in the session's own directory, cached for 5s |
| Tokens used | `ctx.tokenMeter.measure(session)` |
| Turn state | The session's own `turn/start` / `turn/end` events |
| Subagent fan-out | `ctx.subagents.listChildren(sessionId)` |
| Approval policy | `ctx.approval.overrideOf(session)` |

### Status ladder, and one honest gap

T3 Code ranks **pending approval** and **awaiting input** above *Working*. DSH
cannot report either from the Host: a pending approval and an awaiting-input
prompt live in Client chat state that these seats do not receive, and neither
appears in `SessionSnapshot`. So the ladder here is the observable subset —
*failed → working → subagent fan-out → ready* — and the approval **policy** is
reported as its own row rather than mislabelled as a pending request.

## Configuration

```yaml
- id: t3-session-ui
  name: 'dsh-t3-session-ui'
  config:
    machineLabel: "Shima's MacBook Pro"   # optional; defaults to the prettified hostname
```

## Development

Plain ESM, no build step. The Client half is loaded as-is by DSH's client-module
loader, so editing `client.js` takes effect on the next page load.

```sh
pnpm install
pnpm test        # 63 tests: host logic + static rendering of every surface
```

The tests run without DSH: the Client suite stubs `window.__ModuleLoader__` and
renders each surface to static markup against a fixture bundle, and the Host
suite exercises real temporary git repositories.

## Requirements

- DSH `0.1.5-rc.1` or newer
- Node.js 20+

## License

MIT. The ported design is T3 Code's, also MIT.

/**
 * Minimal Chrome DevTools Protocol driver for capturing a LIVE DSH GUI.
 *
 * No Playwright/Puppeteer: CDP is plain JSON over a WebSocket, and `ws` is
 * resolved from a DSH installation you point at. Usage:
 *
 *   DSH_MODULE_RESOLVE=/path/to/a/profile/package.json \
 *     node tools/live-cdp.mjs out.png --wait 6000 --eval "document.title"
 *
 * `DSH_MODULE_RESOLVE` is any file `createRequire` can anchor on (a DSH profile
 * `package.json` works) from which `ws` is resolvable. Nothing about the
 * capturing machine is baked into this file.
 */

import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(process.env.DSH_MODULE_RESOLVE ?? import.meta.url)
let WebSocket
try {
  WebSocket = require('ws')
} catch {
  throw new Error(
    'ws is not resolvable; set DSH_MODULE_RESOLVE to a DSH profile package.json (e.g. ~/.dsh/profiles/web/package.json)',
  )
}

/** Parse argv into a flag map plus the optional output path. */
function parseArgs(argv) {
  const out = { out: undefined, port: 9222, wait: 0, eval: undefined, click: undefined, hover: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--port') out.port = Number(argv[++i])
    else if (arg === '--wait') out.wait = Number(argv[++i])
    else if (arg === '--eval') out.eval = argv[++i]
    else if (arg === '--click') out.click = argv[++i]
    else if (arg === '--hover') out.hover = argv[++i]
    else if (!arg.startsWith('--') && out.out === undefined) out.out = arg
  }
  return out
}

const options = parseArgs(process.argv.slice(2))

/** Find the page target for the app. */
async function findPage(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && !t.url.startsWith('chrome'))
  if (page === undefined) throw new Error('no page target found')
  return page
}

/** A tiny CDP client: one socket, id-matched replies. */
function connect(url) {
  const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
  const pending = new Map()
  let nextId = 1
  socket.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (message.id === undefined) return
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  })
  const ready = new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  return { ready, send, close: () => socket.close() }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const page = await findPage(options.port)
const client = connect(page.webSocketDebuggerUrl)
await client.ready
await client.send('Page.enable')
await client.send('Runtime.enable')
if (options.wait > 0) await sleep(options.wait)

if (options.eval !== undefined) {
  const result = await client.send('Runtime.evaluate', {
    expression: options.eval,
    awaitPromise: true,
    returnByValue: true,
  })
  const value = result?.result?.value
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

/**
 * Resolve a selector to the centre of its first match, in CSS pixels.
 *
 * @param selector - CSS selector.
 * @returns `{ x, y }`, or undefined when nothing matches or it is not visible.
 */
async function centreOf(selector) {
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return null
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
  })()`
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true })
  return result?.result?.value ?? undefined
}

/**
 * Move the real pointer onto an element, which is what a CSS hover and React's
 * synthetic mouse events both react to.
 *
 * @param selector - CSS selector to hover.
 */
async function hover(selector) {
  const point = await centreOf(selector)
  if (point === undefined) throw new Error(`nothing hoverable matched ${selector}`)
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 })
  console.log(`hover ${selector} at ${Math.round(point.x)},${Math.round(point.y)}`)
}

/**
 * Click an element with real mouse events (press then release).
 *
 * @param selector - CSS selector to click.
 */
async function click(selector) {
  const point = await centreOf(selector)
  if (point === undefined) throw new Error(`nothing clickable matched ${selector}`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    })
  }
  console.log(`click ${selector} at ${Math.round(point.x)},${Math.round(point.y)}`)
}

if (options.hover !== undefined) {
  await hover(options.hover)
  await sleep(400)
}

if (options.click !== undefined) {
  await click(options.click)
  await sleep(600)
}

if (options.out !== undefined) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(options.out, Buffer.from(shot.data, 'base64'))
  console.log(`screenshot ${options.out}`)
}

client.close()
process.exit(0)

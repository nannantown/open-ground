// Non-destructive read of a LIVE claude desk's screen.
//   npx tsx scripts/peek-desk.mts <terminalId>
// Pulls the SSE `init` replay, disconnects immediately, replays it into a
// headless xterm and reads it through the SAME readScreen the server uses.
import xterm from '@xterm/headless'
import { readScreen } from '../src/lib/server/terminal'
import { isGenerating, readInputBoxText, extractContextLeftPct } from '../src/lib/claudeScreen'

const BASE = 'http://127.0.0.1:47776'
const id = process.argv[2]
if (!id) throw new Error('usage: peek-desk.mts <terminalId>')

const meta = (await (await fetch(`${BASE}/api/terminal/${id}`)).json()) as {
  cols: number
  rows: number
  lastOutputAt?: number
  menuOpen?: boolean
  deskLabel?: string
}

const ctrl = new AbortController()
const res = await fetch(`${BASE}/api/terminal/${id}/stream`, { signal: ctrl.signal })
const reader = res.body!.getReader()
const dec = new TextDecoder()
let buf = ''
let replay: string | null = null
const deadline = Date.now() + 8000
while (replay === null && Date.now() < deadline) {
  const { value, done } = await reader.read()
  if (done) break
  buf += dec.decode(value, { stream: true })
  let idx: number
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const chunk = buf.slice(0, idx)
    buf = buf.slice(idx + 2)
    let ev = 'message'
    const datas: string[] = []
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) ev = line.slice(6).trim()
      else if (line.startsWith('data:')) datas.push(line.slice(5).replace(/^ /, ''))
    }
    if (ev === 'init') {
      const o = JSON.parse(datas.join('\n')) as { replay?: string }
      replay = o.replay ?? ''
      break
    }
  }
}
ctrl.abort()
try {
  await reader.cancel()
} catch {
  /* stream already torn down */
}

if (replay === null) throw new Error('no init event within 8s')

const term = new xterm.Terminal({ cols: meta.cols, rows: meta.rows, allowProposedApi: true })
await new Promise<void>((resolve) => term.write(replay!, resolve))
const screen = readScreen(term as never)

console.log('=== desk', id, meta.deskLabel ?? '', '===')
console.log('cols/rows       :', meta.cols, 'x', meta.rows)
console.log('lastOutputAt    :', meta.lastOutputAt ? new Date(meta.lastOutputAt).toISOString() : '(none)')
console.log('silence         :', meta.lastOutputAt ? Math.round((Date.now() - meta.lastOutputAt) / 1000) + 's' : '?')
console.log('menuOpen        :', meta.menuOpen)
console.log('isGenerating    :', isGenerating(screen))
console.log('inputBoxText    :', JSON.stringify(readInputBoxText(screen)))
console.log('contextLeftPct  :', extractContextLeftPct(screen))
console.log('replay bytes    :', replay.length)
console.log('--- SCREEN ---')
console.log(screen)
console.log('--- END ---')

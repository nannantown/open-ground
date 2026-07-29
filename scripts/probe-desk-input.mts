// Does a LIVE desk still accept input? Types a marker, reads the screen back,
// then erases it with backspaces. NEVER sends CR.
//   npx tsx scripts/probe-desk-input.mts <terminalId>
import xterm from '@xterm/headless'
import { readScreen } from '../src/lib/server/terminal'
import { isGenerating, readInputBoxText } from '../src/lib/claudeScreen'

const BASE = 'http://127.0.0.1:47776'
const id = process.argv[2]
if (!id) throw new Error('usage: probe-desk-input.mts <terminalId>')
const MARKER = 'OGPROBE'

const meta = async () =>
  (await (await fetch(`${BASE}/api/terminal/${id}`)).json()) as {
    cols: number
    rows: number
    menuOpen?: boolean
    lastOutputAt?: number
  }

const snapshot = async (cols: number, rows: number) => {
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
        replay = (JSON.parse(datas.join('\n')) as { replay?: string }).replay ?? ''
        break
      }
    }
  }
  ctrl.abort()
  try {
    await reader.cancel()
  } catch {
    /* already gone */
  }
  if (replay === null) throw new Error('no init event within 8s')
  const term = new xterm.Terminal({ cols, rows, allowProposedApi: true })
  await new Promise<void>((r) => term.write(replay!, r))
  return readScreen(term as never)
}

const send = async (data: string) => {
  const r = await fetch(`${BASE}/api/terminal/${id}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  return { status: r.status, body: await r.text() }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const m0 = await meta()
const before = await snapshot(m0.cols, m0.rows)
console.log('[0] isGenerating:', isGenerating(before), '| inputBox:', JSON.stringify(readInputBoxText(before)), '| menuOpen:', m0.menuOpen)
if (isGenerating(before) || m0.menuOpen || (readInputBoxText(before) ?? 'x') !== '') {
  console.log('ABORT — desk is not in the safe-to-write state (busy / menu / non-empty input)')
  process.exit(2)
}

const r1 = await send(MARKER)
console.log('[1] POST /input ->', r1.status, r1.body.slice(0, 120))
await wait(2500)
const after = await snapshot(m0.cols, m0.rows)
const seen = readInputBoxText(after)
console.log('[2] inputBox after typing:', JSON.stringify(seen))
console.log('[2] marker echoed        :', (seen ?? '').includes(MARKER) ? 'YES — PTY と claude は入力を受け付けている' : 'NO — 入力が画面に反映されていない')

const r2 = await send('\x7f'.repeat(MARKER.length))
console.log('[3] erase ->', r2.status)
await wait(2000)
const cleaned = await snapshot(m0.cols, m0.rows)
console.log('[4] inputBox after erase :', JSON.stringify(readInputBoxText(cleaned)))

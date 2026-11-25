// Read-only (2026-11-24): what a pane opened on a LIVE claude desk would write
// back into it. Pulls the SSE `init` replay (as peek-desk.mts does), replays it
// into a headless xterm — the same engine as the app's TerminalPane — and prints
// whether focus reporting (DECSET 1004) is on at the end of it (every click into
// or out of the pane then writes ESC[I / ESC[O through /input = writeInput) and
// what the terminal answers by itself while replaying (DA / DSR / OSC replies).
// Imports nothing from src/lib/server.
//   npx tsx scripts/probe-desk-focus-mode.mts <terminalId> [<terminalId> …]
import xterm from '@xterm/headless'

const BASE = process.env.OG ?? 'http://127.0.0.1:47776'
const ids = process.argv.slice(2)
if (!ids.length) throw new Error('usage: probe-desk-focus-mode.mts <terminalId> [...]')

const readReplay = async (id: string): Promise<string> => {
  const ctrl = new AbortController()
  const res = await fetch(`${BASE}/api/terminal/${id}/stream`, { signal: ctrl.signal })
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + 8000
  try {
    while (Date.now() < deadline) {
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
        if (ev === 'init') return (JSON.parse(datas.join('\n')) as { replay?: string }).replay ?? ''
      }
    }
  } finally {
    ctrl.abort()
    await reader.cancel().catch(() => {})
  }
  throw new Error(`${id}: no init event within 8s`)
}

for (const id of ids) {
  const meta = (await (await fetch(`${BASE}/api/terminal/${id}`)).json()) as { cols: number; rows: number }
  const replay = await readReplay(id)
  const term = new xterm.Terminal({ cols: meta.cols, rows: meta.rows, allowProposedApi: true })
  const answers: string[] = []
  term.onData((d) => answers.push(JSON.stringify(d)))
  await new Promise<void>((resolve) => term.write(replay, resolve))
  const count = (s: string) => replay.split(s).length - 1
  console.log(
    `${id}: replay ${replay.length} chars · ESC[?1004h ×${count('\x1b[?1004h')} · ESC[?1004l ×${count('\x1b[?1004l')}` +
      ` · focus reporting at the end: ${term.modes.sendFocusMode}` +
      ` · answered by itself: ${answers.length ? answers.join(' ') : '(nothing)'}`,
  )
}
process.exit(0)

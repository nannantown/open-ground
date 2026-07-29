// probe-desk-screen.mts — read a LIVE claude desk's screen WITHOUT touching it.
//
// Why this exists: the screen buffer lives only inside the server process
// (globalThis), so importing terminal.ts from another process yields nothing.
// The only non-destructive path is the SSE `init` event's `replay`, fed into a
// headless xterm of the same geometry and read back through the PRODUCTION
// `readScreen` (re-implementing it would drift).
//
// Usage: npx tsx scripts/probe-desk-screen.mts <terminalId> [samples] [intervalMs]
import xterm from '@xterm/headless'
import { readScreen } from '../src/lib/server/terminal'
import { isGenerating, readInputBoxText } from '../src/lib/claudeScreen'

const [id, samplesArg, intervalArg] = process.argv.slice(2)
if (!id) throw new Error('usage: probe-desk-screen.mts <terminalId> [samples] [intervalMs]')
const samples = Number(samplesArg ?? 1)
const intervalMs = Number(intervalArg ?? 15_000)

const BASE = 'http://127.0.0.1:47776'

/** One SSE connection, just long enough to take the `init` frame, then hang up.
 *  Held open only for milliseconds — the stream is under ACK-based flow control
 *  and an idle subscriber can pause the PTY. */
const grabInit = async (): Promise<{ replay: string; cols: number; rows: number }> => {
  const ctrl = new AbortController()
  const res = await fetch(`${BASE}/api/terminal/${id}/stream`, {
    headers: { accept: 'text/event-stream' },
    signal: ctrl.signal,
  })
  if (!res.ok || !res.body) throw new Error(`stream ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) throw new Error('stream ended before init')
      buf += dec.decode(value, { stream: true })
      // SSE frames are blank-line separated; we only want the first `init`.
      const end = buf.indexOf('\n\n')
      if (end < 0) continue
      const frame = buf.slice(0, end)
      const evt = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim()
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
      if (evt !== 'init') {
        buf = buf.slice(end + 2)
        continue
      }
      const parsed = JSON.parse(data) as { replay: string; info: { cols?: number; rows?: number } }
      return {
        replay: parsed.replay ?? '',
        cols: parsed.info?.cols ?? 120,
        rows: parsed.info?.rows ?? 40,
      }
    }
  } finally {
    ctrl.abort()
    reader.cancel().catch(() => {})
  }
}

const render = (replay: string, cols: number, rows: number): Promise<string> => {
  const term = new xterm.Terminal({ cols, rows, allowProposedApi: true })
  return new Promise((resolve) => {
    term.write(replay, () => {
      const screen = readScreen(term)
      term.dispose()
      resolve(screen)
    })
  })
}

for (let i = 0; i < samples; i++) {
  const { replay, cols, rows } = await grabInit()
  const screen = await render(replay, cols, rows)
  const box = readInputBoxText(screen)
  const stamp = new Date().toISOString().slice(11, 19)
  console.log(
    JSON.stringify({
      t: stamp,
      geom: `${cols}x${rows}`,
      isGenerating: isGenerating(screen),
      inputBox: box,
      inputBoxEmpty: box === '' || box === null,
      tail: screen.split('\n').slice(-6).map((r) => r.trimEnd()),
    }),
  )
  if (i < samples - 1) await new Promise((r) => setTimeout(r, intervalMs))
}

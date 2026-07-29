// probe-japanese-input-box.mts — the card's unverified premise, measured:
// does `isGenerating` stay FALSE while Japanese text sits UNSENT in a live
// claude desk's input box (the commander's normal state while the owner types)?
//
// Writes into a THROWAWAY desk only (spawn it yourself, pass its id) — never the
// owner's. Nothing is submitted: no CR is ever written, so no turn starts.
//
// Usage: npx tsx scripts/probe-japanese-input-box.mts <throwawayTerminalId>
import xterm from '@xterm/headless'
import { readScreen } from '../src/lib/server/terminal'
import { isGenerating, readInputBoxText } from '../src/lib/claudeScreen'

const id = process.argv[2]
if (!id) throw new Error('usage: probe-japanese-input-box.mts <throwawayTerminalId>')
const BASE = 'http://127.0.0.1:47776'
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const grabScreen = async (): Promise<string> => {
  const ctrl = new AbortController()
  const res = await fetch(`${BASE}/api/terminal/${id}/stream`, {
    headers: { accept: 'text/event-stream' },
    signal: ctrl.signal,
  })
  if (!res.ok || !res.body) throw new Error(`stream ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let init: { replay: string; info: { cols?: number; rows?: number } } | null = null
  try {
    while (!init) {
      const { done, value } = await reader.read()
      if (done) throw new Error('stream ended before init')
      buf += dec.decode(value, { stream: true })
      const end = buf.indexOf('\n\n')
      if (end < 0) continue
      const frame = buf.slice(0, end)
      const evt = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim()
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
      if (evt === 'init') init = JSON.parse(data)
      else buf = buf.slice(end + 2)
    }
  } finally {
    ctrl.abort()
    reader.cancel().catch(() => {})
  }
  const term = new xterm.Terminal({
    cols: init!.info?.cols ?? 120,
    rows: init!.info?.rows ?? 32,
    allowProposedApi: true,
  })
  return new Promise((resolve) => {
    term.write(init!.replay ?? '', () => {
      const s = readScreen(term)
      term.dispose()
      resolve(s)
    })
  })
}

const type = async (data: string) => {
  const res = await fetch(`${BASE}/api/terminal/${id}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  if (!res.ok) throw new Error(`input ${res.status}`)
}

const report = async (label: string) => {
  const screen = await grabScreen()
  const box = readInputBoxText(screen)
  console.log(
    JSON.stringify({
      case: label,
      isGenerating: isGenerating(screen),
      inputBox: (box ?? '').slice(0, 80),
      inputBoxRows: (box ?? '').split('\n').length,
    }),
  )
}

// 0. baseline — desk booted, nothing typed.
await report('booted-empty')

// 1. SHORT Japanese, unsent. What the owner's desk looks like mid-sentence.
await type('統合の判断をしてください')
await wait(1500)
await report('japanese-short-unsent')

// 2. LONG Japanese that WRAPS the input box over several rows — the case worth
//    measuring, since a taller box moves every row the footer scan walks past.
await type(
  'これは司令官の卓で日本語を長く入力している途中の状態を再現するための文章です。' +
    '入力欄が複数行に折り返されたときに画面モデルがどう見えるかを実測します。' +
    'さらに長くして折り返しを確実にします。統合待ちのカードの扱いについて相談したい。',
)
await wait(1500)
await report('japanese-wrapped-unsent')

// 3. The adversarial one: the literal footer phrase typed INTO the box. Must NOT
//    read as generating (the region scan exists for exactly this).
await type(' esc to interrupt')
await wait(1500)
await report('japanese-plus-footer-phrase-unsent')

// Clear the box (Ctrl-U) so the desk is left tidy. Still no CR: nothing submitted.
await type('')
await wait(800)
await report('after-ctrl-u')

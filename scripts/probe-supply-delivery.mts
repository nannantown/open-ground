// Real-claude probe (2026-09-26, "notice stuck in the president's input box"):
// types a supply-desk line into a THROWAWAY claude PTY through the SAME delivery
// function the server uses (injectAnswerIntoWorker, guardEnter — supplyNotice.ts)
// and reports whether it was submitted or left sitting in the box.
//   npx tsx scripts/probe-supply-delivery.mts <trusted cwd> <cols> <rows> <len|multi> [busy]
// `busy` delivers while the desk is still generating its first turn; `owner`
// types 「おーなー」 into the box a moment before the delivery (not yet painted).
// Never touches a live desk. The PTY is killed at the end.
import xterm from '@xterm/headless'
import * as pty from 'node-pty'
import { readScreen } from '../src/lib/server/terminal'
import { isGenerating, readInputBoxText } from '../src/lib/claudeScreen'
import { injectAnswerIntoWorker } from '../src/lib/server/swarmEscalations'
import { supplyReplyLine } from '../src/lib/server/supplyNotice'

const [cwd, colsArg, rowsArg, shape, busy] = process.argv.slice(2)
if (!cwd || !colsArg || !rowsArg || !shape) throw new Error('usage: <cwd> <cols> <rows> <len|multi> [busy]')
const cols = Number(colsArg)
const rows = Number(rowsArg)
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE'))
const term = new xterm.Terminal({ cols, rows, allowProposedApi: true })
const first = busy === 'busy' ? 'Count from 1 to 60, one number per line, then say done.' : 'Reply with just the word hi.'
const p = pty.spawn('claude', ['--model', 'haiku', first], { cols, rows, cwd, env: env as Record<string, string> })
p.onData((d) => term.write(d))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const screen = () => readScreen(term as never)
const body =
  shape === 'multi'
    ? '一行目の報告です。\n二行目の報告です。\n三行目の報告です。'
    : 'テスト用の返事です。'.repeat(Math.ceil(Number(shape) / 10)).slice(0, Number(shape))
const line = shape === 'multi' ? body : supplyReplyLine(body)
try {
  if (busy === 'busy') {
    for (let i = 0; i < 60 && !isGenerating(screen()); i++) await sleep(500)
  } else {
    for (let i = 0; i < 90; i++) {
      await sleep(1000)
      const s = screen()
      if (i > 5 && !isGenerating(s) && readInputBoxText(s) !== null && /hi/i.test(s)) break
    }
    await sleep(3000)
  }
  const before = screen()
  console.log(`cols=${cols} rows=${rows} lineLen=${line.length} generating=${isGenerating(before)} box=${JSON.stringify(readInputBoxText(before))}`)
  const writes: string[] = []
  // The server's foreign-input record (terminal.terminalForeignInput): the
  // owner's keystrokes count, our delivery writes do not.
  const fi = { seq: 0, at: 0 }
  if (busy === 'owner') {
    p.write('おーなー')
    fi.seq += 1
    fi.at = Date.now()
  }
  const ok = await injectAnswerIntoWorker('probe', line, {
    write: (_id, data) => {
      writes.push(data.length > 20 ? `<${data.length} chars>` : JSON.stringify(data))
      p.write(data)
      return true
    },
    readScreen: () => screen(),
    guardEnter: true,
    foreignInput: () => fi,
  })
  console.log(`injectAnswerIntoWorker => ${ok}  writes=${writes.join(' ')}`)
  await sleep(busy === 'busy' ? 20000 : 4000)
  const after = screen()
  console.log(`after: generating=${isGenerating(after)} box=${JSON.stringify((readInputBoxText(after) ?? 'null').slice(0, 80))}`)
  console.log('--- SCREEN ---\n' + after + '\n--- END ---')
} finally {
  p.kill()
}
process.exit(0)

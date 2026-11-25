// Real-claude probe (2026-11-23): how Claude Code draws an input box taller than
// it can show, and how Ctrl+A / Ctrl+E move that view. Pastes one long line into
// a THROWAWAY claude PTY (never a live desk) and prints the bottom of the frame
// after the paste, after Ctrl+A and after Ctrl+E, each with what the app's
// reader (readInputBoxText) makes of it. Nothing is submitted; the PTY is killed.
//   npx tsx scripts/probe-scrolled-box-frames.mts <trusted cwd> <cols> <rows> <len>
// Uses a throwaway OPENGROUND_HOME — never the real one (docs/commander 06 §1.15).
import xterm from '@xterm/headless'
import * as pty from 'node-pty'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isGenerating, readInputBoxText } from '../src/lib/claudeScreen'

// Set before any server module loads (a static import would load it first).
process.env.OPENGROUND_HOME = mkdtempSync(join(tmpdir(), 'og-probe-box-'))
const { readScreen } = await import('../src/lib/server/terminal')

const [cwd, colsArg, rowsArg, lenArg] = process.argv.slice(2)
if (!cwd || !colsArg || !rowsArg || !lenArg) throw new Error('usage: <cwd> <cols> <rows> <len>')
const cols = Number(colsArg)
const rows = Number(rowsArg)
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE'))
const term = new xterm.Terminal({ cols, rows, allowProposedApi: true })
const p = pty.spawn('claude', ['--model', 'haiku', 'Reply with just the word hi.'], { cols, rows, cwd, env: env as Record<string, string> })
p.onData((d) => term.write(d))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const screen = () => readScreen(term as never)
const line = '【テスト】' + 'テスト用の長い一行です。'.repeat(Math.ceil(Number(lenArg) / 12)).slice(0, Number(lenArg)) + '(おわり)'
const show = (label: string) => {
  const s = screen()
  console.log(`\n=== ${label} — box: ${JSON.stringify(readInputBoxText(s))}`)
  console.log(s.split('\n').slice(-16).join('\n'))
}
try {
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    const s = screen()
    if (i > 5 && !isGenerating(s) && readInputBoxText(s) === '' && /hi/i.test(s)) break
  }
  await sleep(2000)
  console.log(`cols=${cols} rows=${rows} lineLen=${line.length}`)
  p.write(`\x1b[200~${line}\x1b[201~`)
  await sleep(1500)
  show('after paste')
  p.write('\x01')
  await sleep(600)
  show('after Ctrl+A')
  p.write('\x05')
  await sleep(600)
  show('after Ctrl+E')
} finally {
  p.kill()
}
process.exit(0)

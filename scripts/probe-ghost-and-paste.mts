// Real-claude probe (2026-09-24, supply-notice ghost-text fix): how does the
// input row render (a) claude's prompt-suggestion ghost text after a turn and
// (b) a pasted multi-line block's 「[Pasted text …]」 marker? Prints the per-cell
// dim flag of every `❯` row, plus readInputBoxText through the server's readScreen.
// Never submits the paste (clears it with Ctrl-U). Throwaway PTY, killed at the end.
//   npx tsx scripts/probe-ghost-and-paste.mts <cwd of a TRUSTED project>
import xterm from '@xterm/headless'
import * as pty from 'node-pty'
import { readScreen } from '../src/lib/server/terminal'
import { isGenerating, readInputBoxText } from '../src/lib/claudeScreen'

const cwd = process.argv[2]
if (!cwd) throw new Error('usage: probe-ghost-and-paste.mts <cwd>')
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE'))
const cols = 80
const rows = 30
const term = new xterm.Terminal({ cols, rows, allowProposedApi: true })
const p = pty.spawn('claude', ['--model', 'haiku', 'Reply with just the word hi.'], { cols, rows, cwd, env: env as Record<string, string> })
p.onData((d) => term.write(d))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const dump = (label: string) => {
  const screen = readScreen(term as never)
  console.log(`\n=== ${label} === generating=${isGenerating(screen)} inputBoxText=${JSON.stringify(readInputBoxText(screen))}`)
  const buf = term.buffer.active
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.baseY + y)
    if (!line || !/^\s*❯/.test(line.translateToString(true))) continue
    const cells: string[] = []
    for (let x = 0; x < term.cols; x++) {
      const c = line.getCell(x)
      if (!c || !c.getChars().trim()) continue
      cells.push(`${c.getChars()}${c.isDim() ? '(dim)' : ''}`)
    }
    console.log(`row ${y}: ${cells.join('')}`)
  }
}

try {
  // Wait for the turn to finish (not generating, box readable) — up to 90s.
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    const s = readScreen(term as never)
    if (i > 5 && !isGenerating(s) && readInputBoxText(s) !== null && /hi/i.test(s)) break
  }
  await sleep(4000) // give the suggestion time to appear
  dump('after turn (ghost suggestion?)')
  p.write('\x1b[200~line one\nline two\nline three\nline four\x1b[201~')
  await sleep(1500)
  dump('after multi-line paste')
  p.write('\x15') // Ctrl-U: clear the box, never submit
  await sleep(800)
  p.write('\x1b[200~short single paste\x1b[201~')
  await sleep(1200)
  dump('after single-line paste')
  p.write('\x15')
  await sleep(800)
  p.write('typed')
  await sleep(800)
  dump('after typing')
} finally {
  p.kill()
}
process.exit(0)

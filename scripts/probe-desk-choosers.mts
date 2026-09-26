// probe-desk-choosers.mts — what does a REAL claude chooser frame look like on
// a president-shaped desk (bypass + Remote Control, 158x22)? Prints the frame
// and how detectMenu / noticeHoldReason read it, so the menu gate can be
// checked against the real thing instead of a hand-drawn fixture.
//
//   OPENGROUND_HOME=$(mktemp -d) npx tsx scripts/probe-desk-choosers.mts <trusted dir> model|ask|multi
//
// `model` types /model; `ask` has claude call AskUserQuestion; `multi` asks a
// multiSelect question and walks the cursor down one row at a time (down to the
// un-numbered Submit row and past it), reading the frame at every step. ESC
// closes the chooser before the desk is killed.
import { randomUUID } from 'node:crypto'
import { launchClaude } from '../src/lib/server/claudeTerminal'
import { getTerminalScreen, getTerminal, killTerminal, writeInput } from '../src/lib/server/terminal'
import { isGenerating } from '../src/lib/claudeScreen'
import { detectMenu } from '../src/lib/claudeMenu'
import { noticeHoldReason } from '../src/lib/server/deskDeliverable'

const [cwd, mode] = process.argv.slice(2)
if (!cwd || !['model', 'ask', 'multi'].includes(mode) || !process.env.OPENGROUND_HOME) {
  throw new Error('usage: OPENGROUND_HOME=<tmp> probe-desk-choosers.mts <dir> model|ask|multi')
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const ref = launchClaude({
  cwd,
  agentSessionId: randomUUID(),
  permissionMode: 'bypass',
  cols: 158,
  rows: 22,
  remoteControl: `og-probe-${process.pid}`,
  ...(mode === 'ask'
    ? {
        initialPrompt:
          'AskUserQuestion ツールで「色はどれにしますか?」と1問だけ聞いてください。選択肢は「赤」「青」の2つ。ほかのツールは使わないでください。',
      }
    : mode === 'multi'
      ? {
          initialPrompt:
            'AskUserQuestion ツールを multiSelect: true で使い、「好きな色は?(複数可)」と1問だけ聞いてください。選択肢は「赤」「青」の2つ。ほかのツールは使わないでください。',
        }
      : {}),
})
const id = ref.terminalId
const settled = async (pred: (s: string) => boolean, ms: number): Promise<string> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await sleep(1000)
    const s = getTerminalScreen(id) ?? ''
    const quiet = Date.now() - (getTerminal(id)?.lastOutputAt ?? Date.now()) > 3000
    if (quiet && !isGenerating(s) && pred(s)) return s
  }
  return getTerminalScreen(id) ?? '(none)'
}
try {
  if (mode === 'model') {
    await settled((s) => s.includes('❯'), 60_000)
    writeInput(id, '/model')
    await sleep(800)
    writeInput(id, '\r')
  }
  const s = await settled((f) => /❯\s*1\./.test(f), 180_000)
  const show = (f: string, label: string) => {
    console.log(`--- FRAME ${label} ---\n` + f + '\n--- END ---')
    console.log('detectMenu      :', JSON.stringify(detectMenu(f)?.options.map((o) => o.label) ?? null))
    console.log('noticeHoldReason:', noticeHoldReason(f))
  }
  show(s, 'cursor 0')
  for (let step = 1; mode === 'multi' && step <= 4; step++) {
    writeInput(id, '\x1b[B') // ↓
    await sleep(1500)
    show(getTerminalScreen(id) ?? '(none)', `down ${step}`)
  }
  writeInput(id, '\x1b')
  await sleep(1500)
} finally {
  killTerminal(id)
  await sleep(500)
  process.exit(0)
}

// probe-supply-numbered-list.mts — does a commander reply reach an IDLE
// president desk whose last answer ends in a numbered list?
//
// Real claude PTY (bypass permissions + Remote Control, like the president desk
// swarmSupply launches), real headless screen, real delivery code
// (queueSupplyReply → flushSupplyNotices), real Enter/landing check. Only the
// desk LIST is injected (this process has its own pool, the app's server
// cannot see this desk) and the queue file lives in a throwaway
// OPENGROUND_HOME, so the app's own ~/.openground queue is never written.
//
// Found 2026-09-26: Echona's president held three replies for ~55 minutes.
//
// Usage (from the repo root; needs a folder claude already trusts):
//   OPENGROUND_HOME=$(mktemp -d) npx tsx scripts/probe-supply-numbered-list.mts <trusted project dir> [passes]
import { randomUUID } from 'node:crypto'
import { launchClaude } from '../src/lib/server/claudeTerminal'
import { getTerminalScreen, getTerminal, killTerminal } from '../src/lib/server/terminal'
import { isGenerating, readInputBoxText } from '../src/lib/claudeScreen'
import { detectMenu } from '../src/lib/claudeMenu'
import { noticeDeliverable } from '../src/lib/server/deskDeliverable'
import { queueSupplyReply, flushSupplyNotices, peekSupplyReplies } from '../src/lib/server/supplyNotice'

const cwd = process.argv[2]
const passes = Number(process.argv[3] ?? 3)
if (!cwd || !process.env.OPENGROUND_HOME) throw new Error('usage: OPENGROUND_HOME=<tmp> probe-supply-numbered-list.mts <dir> [passes]')

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const PROMPT =
  'ツールは使わずに、次の文章だけをそのまま返してください。\n\nこのあとの作業を、次の順番で並べています。\n1. 保存先の選択肢\n2. ウェブの案内ページ\n3. 画面写真と説明文\n\n順番どおりに進めます。'

const ref = launchClaude({
  cwd,
  agentSessionId: randomUUID(),
  permissionMode: 'bypass',
  cols: 158,
  rows: 22,
  initialPrompt: PROMPT,
  remoteControl: `og-probe-${process.pid}`,
})
const id = ref.terminalId
const idleFrame = async (label: string, timeoutMs: number): Promise<string> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(1000)
    const s = getTerminalScreen(id)
    const quietFor = Date.now() - (getTerminal(id)?.lastOutputAt ?? Date.now())
    if (s && !isGenerating(s) && readInputBoxText(s) === '' && quietFor > 4000 && s.includes('3. ')) return s
  }
  throw new Error(`${label}: no idle frame within ${timeoutMs}ms`)
}
try {
  const screen = await idleFrame('answer', 180_000)
  console.log('--- IDLE FRAME ---\n' + screen + '\n--- END ---')
  console.log('detectMenu        :', JSON.stringify(detectMenu(screen)?.options.map((o) => o.label) ?? null))
  console.log('noticeDeliverable :', noticeDeliverable(screen))
  const noop = { onReplyExpired: () => {}, onNoticeGivenUp: () => {}, openQuestions: async () => [] }
  const desks = () => [{ id, cwd }]
  const t0 = Date.now()
  await queueSupplyReply(cwd, 'これは配達の確認です。返事は「受け取りました」の一言だけで構いません。', { desks, ...noop })
  let n = 0
  while (peekSupplyReplies().size > 0 && n < passes) {
    n++
    await sleep(15_000) // stand-in for the 60 s loop, shortened
    await flushSupplyNotices({ desks, ...noop })
  }
  const left = peekSupplyReplies().size
  console.log(left === 0 ? `DELIVERED after ${Math.round((Date.now() - t0) / 1000)}s` : `HELD after ${n} passes (${Math.round((Date.now() - t0) / 1000)}s)`)
  await sleep(8000)
  console.log('--- FRAME AFTER ---\n' + (getTerminalScreen(id) ?? '(none)').split('\n').slice(-12).join('\n'))
} finally {
  killTerminal(id)
  await sleep(500)
  process.exit(0)
}

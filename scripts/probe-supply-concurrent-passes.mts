// Real-claude check for the doubled president line (owner reports 2026-11-20 /
// 11-23, docs/commander/06 §1.15): spawns a real `claude` PTY the way the app
// does, waits for its idle prompt, then does what one engine pass moving two
// cards does — two queueSupplyProgress calls back to back — through the REAL
// flushSupplyNotices, screen reader and PTY write. Prints every write and what
// the box holds afterwards (fixed: one PASTE, one ENTER, an empty box).
//   npx tsx scripts/probe-supply-concurrent-passes.mts <trusted projectDir>
// Uses a throwaway OPENGROUND_HOME — never the real one. Never touches a live
// desk. Kills its PTY at the end. Costs one short haiku turn.
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

// Run as the app does, not as a child of a claude session.
for (const k of Object.keys(process.env)) if ((k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) && !['OPENGROUND_HOME', 'HOME'].includes(k)) delete process.env[k]
process.env.OPENGROUND_HOME = mkdtempSync(join(tmpdir(), 'og-probe-supply-'))

const cwd = process.argv[2]
if (!cwd) throw new Error('usage: probe-supply-concurrent-passes.mts <projectDir>')

const { launchClaude } = await import('../src/lib/server/claudeTerminal')
const { getTerminalScreen, writeDeliveryInput, killTerminal } = await import('../src/lib/server/terminal')
const { isGenerating, readInputBoxText } = await import('../src/lib/claudeScreen')
const { queueSupplyProgress, peekSupplyProgress } = await import('../src/lib/server/supplyNotice')

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const ref = launchClaude({ cwd, agentSessionId: randomUUID(), model: 'haiku' })
const id = ref.terminalId
const screen = () => getTerminalScreen(id) ?? ''

try {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const s = screen()
    if (/^\s*❯/m.test(s) && !isGenerating(s) && readInputBoxText(s) === '') break
    await wait(500)
  }
  // Claude Code's own update row is on every long-lived desk; give it a moment.
  for (let i = 0; i < 40 && !/Update installed/.test(screen()); i++) await wait(500)
  console.log(`update row on screen: ${/Update installed/.test(screen())} | box before: ${JSON.stringify(readInputBoxText(screen()))}`)
  const writes: string[] = []
  const deps = {
    desks: () => [{ id, cwd }],
    write: (tid: string, data: string) => {
      writes.push(data === '\r' ? 'ENTER' : data.startsWith('\x1b[200~') ? `PASTE(${data.length})` : JSON.stringify(data))
      return writeDeliveryInput(tid, data)
    },
    openQuestions: async () => [],
    onNoticeGivenUp: () => {},
    onReplyExpired: () => {},
    log: () => {},
  }
  await Promise.all([
    queueSupplyProgress(cwd, '「検証A」に取りかかりました', deps),
    queueSupplyProgress(cwd, '「検証B」に取りかかりました', deps),
  ])
  await wait(1500)
  const after = screen()
  console.log(`writes: ${writes.join(' ') || '(none)'}`)
  console.log(
    `box after: ${JSON.stringify(readInputBoxText(after))} | generating: ${isGenerating(after)} | still queued: ${peekSupplyProgress().size}`,
  )
  console.log(after.split('\n').slice(-14).join('\n'))
} finally {
  killTerminal(id)
  await wait(500)
  process.exit(0)
}

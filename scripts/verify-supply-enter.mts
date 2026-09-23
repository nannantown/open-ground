// Real-claude check for the president-desk delivery (2026-09-23 owner report:
// 「【司令官からの返事】…」 sat typed in the box and never sent).
// Spawns a real `claude` PTY in the given project, waits for its idle prompt,
// delivers a LONG reply, and reports whether the input box emptied.
//   npx tsx scripts/verify-supply-enter.mts <projectDir> new   # queueSupplyReply (the fix)
//   npx tsx scripts/verify-supply-enter.mts <projectDir> old   # the old one-write `${line}\r`
// Uses a throwaway OPENGROUND_HOME; kills the PTY at the end. Costs one short turn.
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

// Run as the app does, not as a child of this claude session.
for (const k of Object.keys(process.env)) {
  if (k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')) continue
  else if (!['OPENGROUND_HOME', 'HOME'].includes(k)) delete process.env[k]
}
process.env.OPENGROUND_HOME = mkdtempSync(join(tmpdir(), 'og-verify-supply-'))

const [cwd, mode] = process.argv.slice(2)
if (!cwd || (mode !== 'new' && mode !== 'old')) throw new Error('usage: verify-supply-enter.mts <projectDir> new|old')

const { launchClaude } = await import('../src/lib/server/claudeTerminal')
const { getTerminalScreen, writeInput, killTerminal } = await import('../src/lib/server/terminal')
const { isGenerating, readInputBoxText } = await import('../src/lib/claudeScreen')
const { queueSupplyReply, supplyReplyLine } = await import('../src/lib/server/supplyNotice')

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
  await wait(1500)
  const text =
    'はい、確認しました。いま進めている2件のうち、1件目は検品が終わって本体に取り込み済みです。' +
    '2件目はテストが1か所だけ通っていないので、作業者に直してもらっています。直り次第お知らせします。' +
    'ご判断いただくことは今のところありません。この返事への返答は不要なので「了解」とだけ返してください。'+
    (process.argv[4] === 'long'
      ? '補足です。検品では画面の表示と保存の両方を確かめ、スマホからの操作でも同じ結果になることを見ています。'.repeat(3)
      : '')
  const line = supplyReplyLine(text)
  console.log(`[mode=${mode}] line length ${line.length}`)
  let waiting: number | null = null
  if (mode === 'old') writeInput(id, `${line}\r`)
  else waiting = await queueSupplyReply(cwd, text, { desks: () => [{ id, cwd }] })
  await wait(4000)
  const after = screen()
  const box = readInputBoxText(after)
  console.log('queue waiting after delivery:', waiting)
  console.log('generating:', isGenerating(after), '| input box:', JSON.stringify(box))
  console.log('--- screen tail ---\n' + after.split('\n').slice(-14).join('\n'))
  const sent = box === '' || isGenerating(after)
  console.log(sent ? 'RESULT: SENT (box empty)' : 'RESULT: STUCK IN THE BOX')
} finally {
  killTerminal(id)
  await wait(500)
  process.exit(0)
}

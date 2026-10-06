// Real-claude check of the assistant's live session (docs/PHONE_LINK.md "The
// assistant"; CLAUDE.md 検証の掟 3 — the claude launch changed).
//
//   npx tsx scripts/verify-assistant-live.mts
//
// OPEN GROUND's data goes to a throwaway OPENGROUND_HOME with one registered
// throwaway project (the real ~/.openground is never touched); claude is the
// REAL signed-in CLI, so this spends a few short haiku turns of the
// subscription. Through the screen's streamed route it prints, per line, the
// seconds to the first thing said (a "let me look" or the answer) and to the
// answer, and what was said — small talk, "where are your records", a look
// into the project, a read outside the allowed area (~/.ssh), and a card.
// It also checks nothing of the talk reached ~/.claude/history.jsonl.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

const HIST = join(homedir(), '.claude', 'history.jsonl')
const histText = (): string => readFileSync(HIST, 'utf8')
const before = histText().length

for (const k of Object.keys(process.env)) {
  if ((k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE') && !['OPENGROUND_HOME', 'HOME'].includes(k)) delete process.env[k]
}
const home = mkdtempSync(join(tmpdir(), 'og-assistant-live-'))
process.env.OPENGROUND_HOME = home
writeFileSync(join(home, 'settings.json'), JSON.stringify({ language: 'ja', swarmLocalOwner: true }))
const proj = join(home, 'work', 'kiwi-shop')
mkdirSync(proj, { recursive: true })
writeFileSync(join(proj, 'README.md'), '# kiwi-shop\nA small shop site. The checkout lives in src/checkout.ts and takes PayPay.\n')
mkdirSync(join(proj, 'src'))
writeFileSync(join(proj, 'src', 'checkout.ts'), 'export const PAYMENT = "PayPay"\nexport const SHIPPING_FEE = 480\n')

const { addImportedProjectEntry } = await import('../src/lib/server/registry')
await addImportedProjectEntry(proj)
const { phoneLinkRoutes } = await import('../server/routes/phoneLink')
const { closeAssistantSession } = await import('../src/lib/server/assistantSession')

const say = async (text: string) => {
  const t0 = Date.now()
  const r = await phoneLinkRoutes.request('/api/phone-link/assistant/say', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, stream: true }),
  })
  let first = 0
  const lines: string[] = []
  const reader = r.body!.getReader()
  const dec = new TextDecoder()
  for (;;) {
    const { value, done } = await reader.read()
    if (value) {
      if (!first) first = Date.now()
      lines.push(...dec.decode(value).split('\n').filter(Boolean))
    }
    if (done) break
  }
  const s = (ms: number) => ((ms - t0) / 1000).toFixed(1) + 's'
  console.log(`\n> ${text}\n  first ${s(first)} / answer ${s(Date.now())}`)
  for (const l of lines) console.log('  ' + l)
}

await phoneLinkRoutes.request('/api/phone-link/assistant/warm', { method: 'POST' })
await say('やあ、元気?')
await say('アシスタントの記録ってどこにある?')
await say('kiwi-shop の送料っていくらになってる?')
await say('~/.ssh の中に何がある?')
await say('kiwi-shop で送料を500円に変えるカードを作って。完了条件は checkout.ts の送料が500でテスト緑。')
const { readProjectData } = await import('../src/lib/server/projectData')
console.log('\nkiwi-shop Board:', (await readProjectData(proj)).tasks.map((t) => `[${t.boardColumn}] ${t.title}`))
closeAssistantSession()
const added = histText().slice(before)
console.log('\nhistory.jsonl grew by', added.length, 'chars; holds the talk:', /kiwi|送料|アシスタントの記録/.test(added))
rmSync(home, { recursive: true, force: true })
process.exit(0)

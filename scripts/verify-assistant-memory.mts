// Real-claude check of the assistant's memory (docs/PHONE_LINK.md "What the
// assistant remembers"; CLAUDE.md 検証の掟 3 — the claude launch changed).
//
//   npx tsx scripts/verify-assistant-memory.mts
//
// OPEN GROUND's data goes to a throwaway OPENGROUND_HOME (the real
// ~/.openground is never touched); claude is the REAL signed-in CLI, so this
// spends four short sonnet turns of the subscription. It shows:
//   1. a line said through the screen's route gets a reply and lands in the log
//   2. a line after 32 old lines folds them into the memo (memo before / after)
//   3. while nobody talks, old lines are folded on their own
//   4. "forget" of the memo's only fact leaves the memo empty
//   and that every line claude added to ~/.claude/history.jsonl for these runs
//   is the fixed kickoff line — none of the talk or the memo.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

// Claude Code's own prompt history — only ever READ here (what got recorded).
const HIST = join(homedir(), '.claude', 'history.jsonl')
const histLines = (): string[] => readFileSync(HIST, 'utf8').split('\n').filter(Boolean)
const before = histLines().length

// A claude started from inside a claude session behaves differently (no
// transcript, child-session mode): run as the app would.
for (const k of Object.keys(process.env)) {
  if ((k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE') && !['OPENGROUND_HOME', 'HOME'].includes(k)) delete process.env[k]
}
const home = mkdtempSync(join(tmpdir(), 'og-assistant-verify-'))
process.env.OPENGROUND_HOME = home
writeFileSync(join(home, 'settings.json'), JSON.stringify({ language: 'ja', swarmLocalOwner: true }))

const { phoneLinkRoutes } = await import('../server/routes/phoneLink')
const mem = await import('../src/lib/server/assistantMemory')
const { foldIdleAssistantTalk } = await import('../src/lib/server/phoneAssistant')

const say = async (text: string) => {
  const r = await phoneLinkRoutes.request('/api/phone-link/assistant/say', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  return { status: r.status, body: await r.json() }
}
const DAY = 86_400_000
const seed = (topic: string[], ago: number) =>
  mem.appendAssistantEntries(
    topic.flatMap((t, i) => [
      { at: Date.now() - ago + i * 2000, who: 'owner' as const, text: t, via: 'phone' as const },
      { at: Date.now() - ago + i * 2000 + 1000, who: 'assistant' as const, text: 'わかった', via: 'phone' as const },
    ]),
  )

console.log('== 1. screen line')
console.log(JSON.stringify(await say('うちの猫の名前はミケ。覚えておいて')))
console.log('memo:', JSON.stringify(await mem.readAssistantMemory()))

console.log('== 2. a line after 32 old lines (2 days old) — they must fold into the memo')
await seed(
  Array.from({ length: 16 }, (_, i) => (i === 3 ? '来週の金曜15時に歯医者を予約した' : i === 9 ? 'コーヒーは浅煎りが好き' : `雑談${i}`)),
  2 * DAY,
)
const memo2 = await mem.readAssistantMemory()
console.log(JSON.stringify(await say('最近どう?')))
console.log('memo before:', JSON.stringify(memo2))
console.log('memo after :', JSON.stringify(await mem.readAssistantMemory()))
console.log('folded:', JSON.stringify(await mem.readFolded()))

console.log('== 3. nobody talking — old lines fold on their own')
// Later than what step 2 folded (the log is in time order), older than a day.
await seed(['妹の誕生日は12月3日', 'プレゼントは本がいい'], 1.5 * DAY)
const memo3 = await mem.readAssistantMemory()
console.log('folded something:', await foldIdleAssistantTalk())
console.log('memo before:', JSON.stringify(memo3))
console.log('memo after :', JSON.stringify(await mem.readAssistantMemory()))

console.log('== 4. "forget" the memo\'s only fact — the memo must come out empty')
// Nothing else anywhere: the recent talk of steps 1-3 would hand facts back.
await mem.clearAssistantLog()
await mem.clearAssistantMemory()
await mem.writeAssistantMemory('オーナーは朝はコーヒー派。', 4000)
console.log(JSON.stringify(await say('朝はコーヒーのこと、忘れて')))
const memo4 = await mem.readAssistantMemory()
console.log('memo after :', JSON.stringify(memo4))

console.log('== ~/.claude/history.jsonl: lines added for the assistant runs')
const added = histLines()
  .slice(before)
  .map((l) => JSON.parse(l) as { display?: string; project?: string; pastedContents?: unknown })
  .filter((e) => String(e.project).includes('openground-assistant-'))
for (const e of added) console.log(JSON.stringify({ display: e.display, pasted: JSON.stringify(e.pastedContents ?? {}).length }))
const leaked = added.filter((e) => /ミケ|歯医者|浅煎り|誕生日|コーヒー/.test(JSON.stringify(e)))
console.log(`added ${added.length}, carrying talk or memo: ${leaked.length}`)

rmSync(home, { recursive: true, force: true })
process.exit(leaked.length || !added.length || memo4 ? 1 : 0)

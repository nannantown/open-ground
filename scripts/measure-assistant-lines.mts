// The assistant's answers to the same lines, before and after a change: per line,
// the seconds from sending to the first thing it can read aloud (a wait-line or
// the first sentence), to the answer's first sentence, and to the answer — and
// the answer itself, to compare what it said (docs/PHONE_LINK.md "Two models").
//
//   npx tsx scripts/measure-assistant-lines.mts [lines-file]   (ROUNDS=n, NO_OPUS=1)
//
// OPEN GROUND's data goes to a throwaway OPENGROUND_HOME with one throwaway shop
// project beside it (outside the home: the assistant never reads unlisted places
// of its own data folder); claude is the REAL signed-in CLI, so each line is a
// real turn of the subscription. One JSON line per answer on stdout; the server's
// "[assistant] answered by <model>" lines say which model wrote each. To measure
// "before", run it from a checkout of the older commit.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
for (const k of Object.keys(process.env)) {
  if ((k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE') && !['OPENGROUND_HOME', 'HOME'].includes(k)) delete process.env[k]
}
const home = mkdtempSync(join(tmpdir(), 'og-assistant-measure-'))
process.env.OPENGROUND_HOME = home
writeFileSync(join(home, 'settings.json'), JSON.stringify({ language: 'ja', swarmLocalOwner: true, ...(process.env.NO_OPUS ? { swarmAllowedModels: { fable: true, opus: false, sonnet: true, haiku: true } } : {}) }))
const proj = join(mkdtempSync(join(tmpdir(), 'og-measure-work-')), 'kiwi-shop')
mkdirSync(join(proj, 'src'), { recursive: true })
mkdirSync(join(proj, 'docs'), { recursive: true })
writeFileSync(join(proj, 'README.md'), '# kiwi-shop\nニュージーランド産キウイの小さな通販サイト。個人運営、注文は月に約120件。決済は src/checkout.ts(PayPay のみ)。\n')
writeFileSync(join(proj, 'src', 'checkout.ts'), 'export const PAYMENT = ["PayPay"]\nexport const SHIPPING_FEE = 480 // 全国一律\nexport const FREE_SHIPPING_FROM = null\n')
writeFileSync(join(proj, 'docs', 'sales-2026-09.md'), '# 9月の売上\n- 注文 118件、平均単価 2,150円\n- カゴ落ち率 41%(決済画面での離脱が最多)\n- 問い合わせ: 「クレカで払えない?」12件、「送料が高い」9件\n- 2個買いは全注文の18%\n')
const { addImportedProjectEntry } = await import('../src/lib/server/registry')
await addImportedProjectEntry(proj)
const { phoneLinkRoutes } = await import('../server/routes/phoneLink')
const { closeAssistantSession } = await import('../src/lib/server/assistantSession')

const say = async (text: string) => {
  const t0 = performance.now()
  const r = await phoneLinkRoutes.request('/api/phone-link/assistant/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, stream: true }) })
  let first = 0
  let firstAnswer = 0
  let buf = ''
  const reader = r.body!.getReader()
  const dec = new TextDecoder()
  const out: Record<string, unknown>[] = []
  const take = (l: string) => {
    if (!l.trim()) return
    const o = JSON.parse(l)
    out.push(o)
    const t = performance.now()
    if (!first) first = t
    if (!firstAnswer && !('interim' in o) && !('hush' in o)) firstAnswer = t
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (value) {
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        take(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    }
    if (done) break
  }
  take(buf)
  const end = performance.now()
  const s = (t: number) => +((t - t0) / 1000).toFixed(2)
  const a = (out.at(-1) ?? {}) as Record<string, unknown>
  console.log(JSON.stringify({ q: text, first: s(first), firstAnswer: s(firstAnswer), answer: s(end), interim: out.filter((o) => o.interim).map((o) => o.interim), speak: a.speak, reply: a.reply ?? a }))
}

const LINES = [
  'やあ、元気?',
  '今日は何曜日だっけ?',
  'kiwi-shop の送料っていくらになってる?',
  'kiwi-shop、送料無料ラインを作るべきかな?どう思う?',
  'kiwi-shop の9月の数字を見て、いちばん先に手を打つべきところはどこだと思う?理由も。',
  'kiwi-shop で次に決済を1つ足すならクレカとコンビニ払いどっちがいい?',
]
const lines = process.argv[2] ? readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean) : LINES
const rounds = Number(process.env.ROUNDS ?? 2)
for (let r = 0; r < rounds; r++) {
  closeAssistantSession()
  await phoneLinkRoutes.request('/api/phone-link/assistant/warm', { method: 'POST' })
  await new Promise((ok) => setTimeout(ok, 5000))
  for (const l of lines) await say(l)
}
closeAssistantSession()
rmSync(home, { recursive: true, force: true })
rmSync(join(proj, '..'), { recursive: true, force: true })
process.exit(0)

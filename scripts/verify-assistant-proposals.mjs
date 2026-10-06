// The owner's check for the assistant's proposals, against a running app
// (docs/PHONE_LINK.md "Assistant proposals"): ask for a card → a proposal is
// shown and NOTHING is on the Board; say 「うん」 → still nothing; press 「出す」 (the
// window's route, with the check computed from the shown text) → ONE card with
// exactly the shown title and notes. Also times small talk and a look-up.
//
//   node scripts/verify-assistant-proposals.mjs <baseUrl> <projectPath> "<card request>"
//
// Every line is a real assistant turn on the owner's subscription. Run it
// against an app with an isolated OPENGROUND_HOME and a throwaway project.
import { createHash } from 'crypto'

const [base = 'http://127.0.0.1:47776', path, request] = process.argv.slice(2)
if (!path || !request) throw new Error('usage: <baseUrl> <projectPath> "<card request>"')
const api = (p, init) => fetch(`${base}/api/phone-link/assistant${p}`, init)
const board = async () => ((await (await fetch(`${base}/api/project?path=${encodeURIComponent(path)}`)).json()).tasks ?? []).map((t) => ({ title: t.title, notes: t.notes, col: t.boardColumn }))
const proposals = async () => (await (await api('/proposals')).json()).proposals

/** One line through the window's own route; seconds to the first thing said and to the answer. */
const say = async (text) => {
  const t0 = performance.now()
  const r = await api('/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, stream: true }) })
  let first = 0
  let buf = ''
  const dec = new TextDecoder()
  for await (const chunk of r.body) {
    if (!first) first = performance.now()
    buf += dec.decode(chunk, { stream: true })
  }
  const out = buf.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const s = (t) => Number(((t - t0) / 1000).toFixed(2))
  const a = out.at(-1) ?? {}
  return { text, status: r.status, first: s(first), answer: s(performance.now()), interim: out.slice(0, -1).map((o) => o.interim), speak: a.speak, reply: a.reply, error: a.error }
}

const report = { latency: [], flow: {} }
await api('/warm', { method: 'POST' })
await new Promise((r) => setTimeout(r, 4000)) // the session is up before the first line (as the window warms on opening)
for (const t of ['やあ、元気?', '今日は何曜日だっけ?', 'ありがとう。', 'アシスタントの記録ってどこにある?']) report.latency.push(await say(t))

const before = await board()
const asked = await say(request)
const shown = (await proposals()).filter((p) => p.state === 'open')
report.flow.asked = { ...asked, shown }
report.flow.boardAfterProposal = (await board()).length - before.length
for (const yes of ['うん', 'うん、出して']) await say(yes)
report.flow.boardAfterSpokenYes = (await board()).length - before.length
report.flow.stillOpenAfterYes = (await proposals()).filter((p) => p.state === 'open').length
const p = shown.find((x) => x.kind === 'card')
if (p) {
  const hash = createHash('sha256').update([p.kind, p.projectId, p.project, p.title, p.body].join('\n'), 'utf8').digest('hex')
  const wrong = await api(`/proposals/${p.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash: hash.replace(/^./, (c) => (c === '0' ? '1' : '0')) }) })
  report.flow.wrongCheck = { status: wrong.status, board: (await board()).length - before.length }
  const ok = await api(`/proposals/${p.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash }) })
  const after = await board()
  const added = after.slice(before.length)
  report.flow.pressed = { status: ok.status, line: (await ok.json()).line, added, sameAsShown: added.length === 1 && added[0].title === p.title && added[0].notes === p.body && added[0].col === 'todo' }
}
console.log(JSON.stringify(report, null, 2))

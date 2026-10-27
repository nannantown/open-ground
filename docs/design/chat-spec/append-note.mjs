// Writes pair-cards.md (the proposed iOS + desktop card pairs) at the end of a Board card's
// notes, replacing an earlier copy of that section. Same CAS PUT as attach.mjs.
//   node docs/design/chat-spec/append-note.mjs <card id>
import { readFileSync } from 'node:fs'

const OG = process.env.OG || 'http://127.0.0.1:47776'
const HEAD = '## 直しのカードの案'
const card = process.argv[2]
if (!card) throw new Error('usage: append-note.mjs <card id>')
const section = readFileSync(new URL('./pair-cards.md', import.meta.url), 'utf8').trim()
const reg = await (await fetch(`${OG}/api/projects`)).json()
const PROJECT = (reg.projects ?? reg.settings.projects).find((p) => p.path.endsWith('/OPEN GROUND')).path
const url = `${OG}/api/project?path=${encodeURIComponent(PROJECT)}`
for (let attempt = 0; attempt < 5; attempt++) {
  const data = await (await fetch(url)).json()
  const t = data.tasks?.find((x) => x.id === card)
  if (!t) throw new Error(`card not found: ${card}`)
  const notes = String(t.notes ?? '')
  const at = notes.indexOf(HEAD)
  t.notes = (at >= 0 ? notes.slice(0, at).trimEnd() : notes.trimEnd()) + '\n\n' + section + '\n'
  const r = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
  if (r.status !== 409) { console.log(`notes updated on ${card} (status ${r.status})`); process.exit(0) }
}
throw new Error('board kept changing; notes not written')

// Attaches the Canvas 「チャットの違い」 screenshots (whole page + close-ups, light and dark)
// to a Board card, replacing this page's earlier attachments on that card. Same upload +
// CAS PUT as ~/.claude/openground-canvas-shot.mjs; names keep its `-canvas-light.png` /
// `-canvas-dark.png` tail for the whole-page shots.
//   node docs/design/chat-spec/attach.mjs <card id> <png> [<png> …]
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const OG = process.env.OG || 'http://127.0.0.1:47776'
const PREFIX = 'チャットの違い-'
const [card, ...files] = process.argv.slice(2)
if (!card || !files.length) throw new Error('usage: attach.mjs <card id> <png> …')
const reg = await (await fetch(`${OG}/api/projects`)).json()
const PROJECT = (reg.projects ?? reg.settings.projects).find((p) => p.path.endsWith('/OPEN GROUND')).path
const q = `path=${encodeURIComponent(PROJECT)}`
const call = async (method, url, body) => {
  const r = await fetch(`${OG}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: r.status, json: await r.json().catch(() => null) }
}
const fresh = []
for (const f of files) {
  const { status, json } = await call('POST', '/api/project/task-asset', { path: PROJECT, name: PREFIX + basename(f), mime: 'image/png', dataBase64: readFileSync(f).toString('base64') })
  if (status !== 200) throw new Error(`upload ${f}: ${status}`)
  fresh.push(json)
}
for (let attempt = 0; attempt < 5; attempt++) {
  const { json: data } = await call('GET', `/api/project?${q}`)
  const t = data.tasks?.find((x) => x.id === card)
  if (!t) throw new Error(`card not found: ${card}`)
  t.attachments = [...(t.attachments ?? []).filter((a) => !String(a.name ?? '').startsWith(PREFIX)), ...fresh]
  const { status } = await call('PUT', `/api/project?${q}`, data)
  if (status !== 409) { console.log(`attached ${fresh.length} to ${card} (status ${status})`); process.exit(0) }
}
throw new Error('board kept changing; not attached')

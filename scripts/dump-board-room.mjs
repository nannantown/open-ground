// Read-only probe: connect to a project's board collab room and dump what the
// Y.Doc actually holds for one card. Diagnostic only — it never writes.
//
//   node scripts/dump-board-room.mjs "<project path>" <card-id-prefix>
//
// Answers the question the board rollback investigation turns on: while the disk
// says `done`, does the ROOM still say `review`?
import * as Y from 'yjs'
import { WebSocket as WS } from 'ws'

if (typeof globalThis.WebSocket === 'undefined') globalThis.WebSocket = WS

const [, , projectPath, prefix = ''] = process.argv
if (!projectPath) {
  console.error('usage: node scripts/dump-board-room.mjs "<project path>" [card-id-prefix]')
  process.exit(2)
}
const ORIGIN = process.env.OG_ORIGIN ?? 'http://127.0.0.1:47776'

const ticketUrl = `${ORIGIN}/api/collab/ticket?path=${encodeURIComponent(projectPath)}&scope=board`
const mintTicket = async () => {
  const res = await fetch(ticketUrl)
  if (!res.ok) throw new Error(`ticket HTTP ${res.status}`)
  return res.json()
}

const hostFromUrl = (u) => new URL(u).host

const ticket = await mintTicket()
const { default: YProvider } = await import('y-partyserver/provider')

const doc = new Y.Doc()
const provider = new YProvider(hostFromUrl(ticket.wsUrl), ticket.room, doc, {
  party: 'og-collab-doc',
  params: async () => ({ token: (await mintTicket()).token }),
})

const deadline = Date.now() + 15_000
while (Date.now() < deadline && !provider.synced) await new Promise((r) => setTimeout(r, 100))
if (!provider.synced) {
  console.error('sync timeout')
  process.exit(1)
}

const map = doc.getMap('og')
// Which client authored the surviving value of a key — Y.Map keeps the winning
// item per key, and its id.client is the writer. This is how we tell the server
// mirror's ops apart from a browser's.
const authorOf = (key) => {
  try {
    return map._map.get(key)?.id?.client ?? null
  } catch {
    return null
  }
}
const out = {
  room: ticket.room,
  synced: true,
  diskStamp: map.get('m:diskStamp') ?? null,
  probeClientId: doc.clientID,
  card: {},
}
for (const [k, v] of map.entries()) {
  if (!k.startsWith('t:')) continue
  const rest = k.slice(2)
  const sep = rest.indexOf(':')
  if (sep < 0) continue
  const id = rest.slice(0, sep)
  if (prefix && !id.startsWith(prefix)) continue
  const field = rest.slice(sep + 1)
  ;(out.card[id] ??= {})[field] =
    field === 'boardColumn' || field === 'done' ? { value: v, author: authorOf(k) } : v
}
console.log(JSON.stringify(out, null, 2))
provider.destroy()
doc.destroy()
process.exit(0)

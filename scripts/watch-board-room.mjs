// Read-only probe: watch a project's board collab room and log every change to
// one card's boardColumn, with the clientID that authored it and the peers
// present. Diagnostic only — it never writes into the doc.
//
//   node scripts/watch-board-room.mjs "<project path>" <card-id-prefix> <seconds>
//
// Used to catch the board rollback in the act: the disk says `done`, the room
// says `review` — this shows WHO puts `review` back, and when.
import * as Y from 'yjs'
import { WebSocket as WS } from 'ws'

if (typeof globalThis.WebSocket === 'undefined') globalThis.WebSocket = WS

const [, , projectPath, prefix, secsRaw] = process.argv
const secs = Number(secsRaw ?? 120)
if (!projectPath || !prefix) {
  console.error('usage: node scripts/watch-board-room.mjs "<path>" <card-prefix> [seconds]')
  process.exit(2)
}
const ORIGIN = process.env.OG_ORIGIN ?? 'http://127.0.0.1:47776'

const mintTicket = async () => {
  const res = await fetch(
    `${ORIGIN}/api/collab/ticket?path=${encodeURIComponent(projectPath)}&scope=board`,
  )
  if (!res.ok) throw new Error(`ticket HTTP ${res.status}`)
  return res.json()
}

const ticket = await mintTicket()
const { default: YProvider } = await import('y-partyserver/provider')
const doc = new Y.Doc()
const provider = new YProvider(new URL(ticket.wsUrl).host, ticket.room, doc, {
  party: 'og-collab-doc',
  params: async () => ({ token: (await mintTicket()).token }),
})

const log = (...a) => console.log(new Date().toISOString(), ...a)
log('probe clientID', doc.clientID)

const map = doc.getMap('og')
const keyFor = (field) => {
  for (const k of map.keys()) {
    if (k.startsWith('t:') && k.slice(2).startsWith(prefix) && k.endsWith(':' + field)) return k
  }
  return null
}
const colOf = () => {
  const k = keyFor('boardColumn')
  return k ? map.get(k) : '<absent>'
}

const deadline = Date.now() + 15_000
while (Date.now() < deadline && !provider.synced) await new Promise((r) => setTimeout(r, 100))
log('synced', provider.synced, 'column', colOf(), 'diskStamp', map.get('m:diskStamp') ?? null)

let last = colOf()
doc.on('update', (update, origin) => {
  // Which client authored the ops in this update?
  const authors = new Set()
  try {
    const { structs } = Y.decodeUpdate(update)
    for (const s of structs) if (s.id) authors.add(s.id.client)
  } catch {
    /* opaque update — the column readout below still tells the story */
  }
  const now = colOf()
  const tag = now === last ? 'update' : `COLUMN ${last} -> ${now}`
  log(tag, 'authors', [...authors].join(',') || '?', 'origin', String(origin?.constructor?.name ?? origin))
  last = now
})

const aw = provider.awareness
if (aw) {
  const peers = () =>
    [...aw.getStates().entries()]
      .filter(([id]) => id !== aw.clientID)
      .map(([id, st]) => `${id}:${st?.name ?? '?'}`)
  log('peers', peers().join(' ') || '(none)')
  aw.on('change', () => log('peers', peers().join(' ') || '(none)'))
}

setTimeout(() => {
  log('final column', colOf())
  provider.destroy()
  doc.destroy()
  process.exit(0)
}, secs * 1000)

// A stand-in for the iPhone app (docs/PHONE_LINK.md): connect with a pairing
// code, optionally say one line to the president, print every frame that comes
// back, and exit after the president has answered (or the wait runs out).
//
//   node scripts/phone-link-say.mjs <pairing code> ["text to say"] [--wait 120] [--key <override>] [--project <id>]
//
// A v2 code (docs/PHONE_LINK.md "Sealed frames") seals what it says and opens
// what it hears, printing the opened frame after the wire frame.
// --key replaces the phone key (to show a wrong key is refused). Exit codes:
// 0 = the president answered after our line landed (with no text: listen until
// --wait runs out, printing what arrives), 1 = refused / no answer in time.
import WebSocket from 'ws'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(name)
  if (i < 0) return dflt
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const waitS = Number(opt('--wait', '120'))
const keyOverride = opt('--key', null)
const projectId = opt('--project', null)
const [code, text] = args
if (!code) {
  console.error('usage: node scripts/phone-link-say.mjs <pairing code> ["text"] [--wait 120] [--key k]')
  process.exit(2)
}
const pair = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'))
const e2e = pair.v === 2 ? Buffer.from(pair.e2e, 'base64url') : null
const aad = (dir) => Buffer.from(`og-phone-link/v2 ${dir}`, 'utf8')
const seal = (obj) => {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', e2e, iv, { authTagLength: 16 })
  c.setAAD(aad('p2m'))
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()])
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64')
}
const unseal = (box) => {
  try {
    return unsealOrThrow(box)
  } catch {
    return { type: 'unopenable', note: 'did not open with this code — dropped' }
  }
}
const unsealOrThrow = (box) => {
  const raw = Buffer.from(box, 'base64')
  const d = createDecipheriv('aes-256-gcm', e2e, raw.subarray(0, 12), { authTagLength: 16 })
  d.setAAD(aad('m2p'))
  d.setAuthTag(raw.subarray(raw.length - 16))
  return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8'))
}
/** v2: the frame with its box opened (outer seq / type kept); v1: as is. */
const inner = (f) => (e2e && f.box ? { ...unseal(f.box), ...(f.seq ? { seq: f.seq } : {}) } : f)
const ws = new WebSocket(pair.url, { headers: { 'X-OG-Token': keyOverride ?? pair.key } })
const id = `say-${Date.now()}`
let landed = false
const done = (c, why) => {
  console.log(`== ${why}`)
  ws.terminate()
  process.exit(c)
}
setTimeout(() => (text ? done(1, `no answer within ${waitS}s`) : done(0, 'listened')), waitS * 1000).unref()
ws.on('unexpected-response', (_q, res) => done(1, `refused: HTTP ${res.statusCode}`))
ws.on('error', (e) => done(1, `error: ${e.message}`))
ws.on('message', (d) => {
  const wire = JSON.parse(String(d))
  const f = inner(wire)
  console.log(new Date().toISOString(), JSON.stringify(wire))
  if (f !== wire) console.log('   opened', JSON.stringify(f))
  if (f.type === 'hello') {
    if (!text) return
    // v2: a say names its project (the selected one unless --project).
    const selected = e2e && wire.projects?.box ? unseal(wire.projects.box).selected : null
    const pid = projectId ?? selected
    const say = { type: 'say', id, text, ...(pid ? { projectId: pid } : {}) }
    ws.send(JSON.stringify(e2e ? { type: 'say', id, box: seal({ ...say, ts: Date.now() }) } : say))
  }
  if (f.type === 'ack' && f.id === id && f.state === 'rejected') done(1, `rejected: ${f.reason}`)
  if (f.type === 'ack' && f.id === id && f.state === 'delivered') landed = true
  if (f.type === 'event' && f.kind === 'president' && landed) done(0, 'president answered')
  if (f.type === 'event' && f.kind === 'assistant' && landed) done(0, 'assistant answered') // --project assistant
})

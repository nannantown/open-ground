// A stand-in for the iPhone app (docs/PHONE_LINK.md): connect with a pairing
// code, optionally say one line to the president, print every frame that comes
// back, and exit after the president has answered (or the wait runs out).
//
//   node scripts/phone-link-say.mjs <pairing code> ["text to say"] [--wait 120] [--key <override>] [--project <id>]
//
// --key replaces the phone key (to show a wrong key is refused). Exit codes:
// 0 = the president answered after our line landed (with no text: listen until
// --wait runs out, printing what arrives), 1 = refused / no answer in time.
import WebSocket from 'ws'

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
  const f = JSON.parse(String(d))
  console.log(new Date().toISOString(), JSON.stringify(f))
  if (f.type === 'hello') {
    if (!text) return
    ws.send(JSON.stringify({ type: 'say', id, text, ...(projectId ? { projectId } : {}) }))
  }
  if (f.type === 'ack' && f.id === id && f.state === 'rejected') done(1, `rejected: ${f.reason}`)
  if (f.type === 'ack' && f.id === id && f.state === 'delivered') landed = true
  if (f.type === 'event' && f.kind === 'president' && landed) done(0, 'president answered')
})

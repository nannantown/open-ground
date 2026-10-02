// Local test of the phone link relay (src/phoneRelay.ts) against a REAL worker
// booted in-process (wrangler unstable_dev, wrangler.phone.jsonc).
//   run (from worker/):  node test/phoneRelay.local.mjs
// Or point it at a deployed relay without booting one:
//   RELAY=https://og-phone-relay.<sub>.workers.dev node test/phoneRelay.local.mjs
// Asserts what a stranger can and cannot do, and that frames really pass.
import { unstable_dev } from 'wrangler'
import crypto from 'node:crypto'
import WebSocket from 'ws'

const rand = () => crypto.randomBytes(32).toString('base64url')
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

setTimeout(() => { console.log("TIMEOUT"); process.exit(2) }, 90_000).unref()
let worker
let base = process.env.RELAY
if (!base) {
  worker = await unstable_dev('src/phoneRelay.ts', {
    config: 'wrangler.phone.jsonc',
    experimental: { disableExperimentalWarning: true },
    local: true,
  })
  base = `http://${worker.address}:${worker.port}`
}
const wsBase = base.replace(/^http/, 'ws')

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed++
}

/** Open a socket; resolves {ws, status, frames, closed} once open or refused. */
const open = (role, room, token, query = '') =>
  new Promise((resolve) => {
    const frames = []
    const ws = new WebSocket(`${wsBase}/v1/${room}/${role}${query}`, {
      headers: token ? { 'X-OG-Token': token } : {},
    })
    const box = { ws, status: 101, frames, closed: null }
    ws.on('message', (d) => frames.push(JSON.parse(String(d))))
    ws.on('close', (code) => (box.closed = code))
    ws.on('open', () => resolve(box))
    ws.on('unexpected-response', (_req, res) => {
      box.status = res.statusCode
      resolve(box)
    })
    ws.on('error', () => resolve({ ...box, status: box.status === 101 ? 0 : box.status }))
  })
const until = async (pred, ms = 5000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

try {
  const phoneKey = rand()
  const macKey = rand()
  const room = sha(phoneKey)

  check('no key: phone refused (401)', (await open('phone', room, null)).status === 401)
  check('wrong key: phone refused (401)', (await open('phone', room, rand())).status === 401)
  check('phone key cannot claim the Mac end (401)', (await open('mac', room, phoneKey)).status === 401)

  const mac = await open('mac', room, macKey)
  check('Mac end opens with its key', mac.status === 101)
  check('a fresh room tells the Mac it stored nothing (resume null)', await until(() => mac.frames.some((f) => f.type === 'resume' && f.cur === null)))
  check('another Mac key is refused once one registered (401)', (await open('mac', room, rand())).status === 401)

  const phone = await open('phone', room, phoneKey)
  check('phone opens with its key', phone.status === 101)
  check('phone hears hello with the Mac online', await until(() => phone.frames[0]?.type === 'hello' && phone.frames[0].mac === true))

  phone.ws.send(JSON.stringify({ type: 'say', id: 'c1', text: 'こんにちは' }))
  check('phone say reaches the Mac', await until(() => mac.frames.some((f) => f.type === 'say' && f.text === 'こんにちは')))

  phone.ws.send(JSON.stringify({ type: 'hack', x: 1 }))
  check('unknown phone frame is refused, not forwarded', await until(() => phone.frames.some((f) => f.type === 'error' && f.code === 'bad-frame')))
  check('...and never reached the Mac', !mac.frames.some((f) => f.type === 'hack'))

  mac.ws.send(JSON.stringify({ type: 'event', kind: 'president', text: '承知しました' }))
  check('Mac event reaches the phone with seq 1', await until(() => phone.frames.some((f) => f.type === 'event' && f.seq === 1 && f.text === '承知しました')))

  const live = await open('phone', room, phoneKey)
  await until(() => live.frames.length > 0)
  await new Promise((r) => setTimeout(r, 500))
  check('a phone without ?after hears no history', live.frames.length === 1 && live.frames[0].type === 'hello' && live.frames[0].head === 1)
  live.ws.close()
  const late = await open('phone', room, phoneKey, '?after=0')
  check('a reconnecting phone catches up from ?after', await until(() => late.frames.some((f) => f.type === 'event' && f.seq === 1)))
  const stranger = await open('phone', sha(rand()), rand())
  check('a different pair cannot open this room', stranger.status === 401)

  // A socket that died silently: the Mac reconnects, hears where the relay stands,
  // sends again from there — the relay drops what it already has.
  const cur = (o, i) => ({ f: 'p1:s.jsonl', o, i })
  mac.ws.send(JSON.stringify({ type: 'event', kind: 'president', text: 'A', cur: cur(10, 0) }))
  check('a positioned event reaches the phone (seq 2), without its position', await until(() => phone.frames.some((f) => f.type === 'event' && f.seq === 2 && f.text === 'A' && !('cur' in f))))
  const mac2 = await open('mac', room, macKey)
  check('the reconnecting Mac hears the newest stored position', await until(() => mac2.frames.some((f) => f.type === 'resume' && f.cur?.o === 10 && f.cur.i === 0 && f.cur.f === 'p1:s.jsonl')))
  mac2.ws.send(JSON.stringify({ type: 'event', kind: 'president', text: 'A', cur: cur(10, 0) }))
  mac2.ws.send(JSON.stringify({ type: 'event', kind: 'president', text: 'B', cur: cur(20, 0) }))
  check('the resend after it is stored once (seq 3)', await until(() => phone.frames.some((f) => f.type === 'event' && f.seq === 3 && f.text === 'B')))
  check('...and the already stored one is not told twice', phone.frames.filter((f) => f.type === 'event' && f.text === 'A').length === 1)

  mac2.ws.send(JSON.stringify({ type: 'reset' }))
  check('reset closes the phones', await until(() => phone.closed !== null && late.closed !== null, 40000))
  check('after reset the old phone key is refused (401)', (await open('phone', room, phoneKey)).status === 401)
  check('after reset the old Mac key is refused too (401)', (await open('mac', room, macKey)).status === 401)
  for (const b of [mac, mac2, phone, late]) b.ws.close()
} finally {
  await worker?.stop()
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)

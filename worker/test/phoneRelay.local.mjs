// Local test of the phone link relay (src/phoneRelay.ts) against a REAL worker
// booted in-process (wrangler unstable_dev, wrangler.phone.jsonc).
//   run (from worker/):  node test/phoneRelay.local.mjs
// Or point it at a deployed relay without booting one (the expiry / limit part
// needs short limits, so it runs only locally):
//   RELAY=https://og-phone-relay.<sub>.workers.dev APP_KEY=<the relay's ROOM_CREATE_KEY> node test/phoneRelay.local.mjs
// Asserts what a stranger can and cannot do, that frames really pass, and that
// the room is owner-only and bounded (creation key, expiry, connection caps).
import { unstable_dev } from 'wrangler'
import crypto from 'node:crypto'
import WebSocket from 'ws'

const rand = () => crypto.randomBytes(32).toString('base64url')
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** The short relay's idle limit (s), far from its 3 s event lifetime. */
const IDLE_S = 20

setTimeout(() => { console.log("TIMEOUT"); process.exit(2) }, 180_000).unref()
const APP_KEY = process.env.APP_KEY || rand()
const boot = (vars) =>
  unstable_dev('src/phoneRelay.ts', {
    config: 'wrangler.phone.jsonc',
    experimental: { disableExperimentalWarning: true },
    local: true,
    vars,
  })
const workers = []
let base = process.env.RELAY
if (!base) {
  const w = await boot({ ROOM_CREATE_KEY: APP_KEY, ROOM_CREATE: 'gated' })
  workers.push(w)
  base = `http://${w.address}:${w.port}`
}

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed++
}

/** Open a socket; resolves {ws, status, frames, closed} once open or refused.
 *  `appKey` true = the relay's room-creation key, a string = that value. */
const opener = (wsBase) => (role, room, token, query = '', { appKey, headers = {} } = {}) =>
  new Promise((resolve) => {
    const frames = []
    const h = { ...headers }
    if (token) h['X-OG-Token'] = token
    if (appKey) h['X-OG-App-Key'] = appKey === true ? APP_KEY : appKey
    const ws = new WebSocket(`${wsBase}/v1/${room}/${role}${query}`, { headers: h })
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
const open = opener(base.replace(/^http/, 'ws'))
const until = async (pred, ms = 5000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await sleep(50)
  }
  return false
}
const shut = async (...boxes) => {
  for (const b of boxes) b.ws.close()
  await until(() => boxes.every((b) => b.closed !== null))
}

try {
  const phoneKey = rand()
  const macKey = rand()
  const room = sha(phoneKey)

  check('no key: phone refused (401)', (await open('phone', room, null)).status === 401)
  check('wrong key: phone refused (401)', (await open('phone', room, rand())).status === 401)
  check('phone key cannot claim the Mac end (401)', (await open('mac', room, phoneKey, '', { appKey: true })).status === 401)

  // Owner-only: a room is created only by a Mac carrying the app key.
  check('a Mac without the app key cannot create a room (401)', (await open('mac', room, macKey)).status === 401)
  check('a Mac with a wrong app key cannot create a room (401)', (await open('mac', room, macKey, '', { appKey: rand() })).status === 401)
  check('a client-made "may create" header does not help (401)', (await open('mac', room, macKey, '', { headers: { 'x-og-may-create': '1' } })).status === 401)
  check('the phone cannot open a room no Mac created (404: not yet, retry)', (await open('phone', room, phoneKey)).status === 404)

  const mac = await open('mac', room, macKey, '', { appKey: true })
  check('Mac end opens with its key + the app key', mac.status === 101)
  check('a fresh room tells the Mac it stored nothing (resume null)', await until(() => mac.frames.some((f) => f.type === 'resume' && f.cur === null)))
  check('another Mac key is refused once one registered (401)', (await open('mac', room, rand(), '', { appKey: true })).status === 401)

  const phone = await open('phone', room, phoneKey)
  check('phone opens with its key', phone.status === 101)
  check('phone hears hello with the Mac online', await until(() => phone.frames[0]?.type === 'hello' && phone.frames[0].mac === true))

  phone.ws.send(JSON.stringify({ type: 'say', id: 'c1', text: 'こんにちは' }))
  check('phone say reaches the Mac', await until(() => mac.frames.some((f) => f.type === 'say' && f.text === 'こんにちは')))

  // The phone's frame cap (16 KiB) is a quarter of the Mac's: a bigger one is refused.
  phone.ws.send(JSON.stringify({ type: 'say', id: 'big', text: 'x'.repeat(17 * 1024) }))
  check('a phone frame over its size cap is refused', await until(() => phone.frames.some((f) => f.type === 'error' && f.code === 'bad-frame')))
  await sleep(300)
  check('...and never reached the Mac', !mac.frames.some((f) => f.type === 'say' && f.id === 'big'))

  phone.ws.send(JSON.stringify({ type: 'hack', x: 1 }))
  check('unknown phone frame is refused, not forwarded', await until(() => phone.frames.filter((f) => f.type === 'error' && f.code === 'bad-frame').length === 2))
  check('...and never reached the Mac', !mac.frames.some((f) => f.type === 'hack'))

  mac.ws.send(JSON.stringify({ type: 'event', kind: 'president', text: '承知しました' }))
  check('Mac event reaches the phone with seq 1', await until(() => phone.frames.some((f) => f.type === 'event' && f.seq === 1 && f.text === '承知しました')))

  const live = await open('phone', room, phoneKey)
  await until(() => live.frames.length > 0)
  await sleep(500)
  check('a phone without ?after hears no history', live.frames.length === 1 && live.frames[0].type === 'hello' && live.frames[0].head === 1)
  await shut(live)
  const late = await open('phone', room, phoneKey, '?after=0')
  check('a reconnecting phone catches up from ?after', await until(() => late.frames.some((f) => f.type === 'event' && f.seq === 1)))
  await shut(late)
  const stranger = await open('phone', sha(rand()), rand())
  check('a different pair cannot open this room', stranger.status === 401)

  // A socket that died silently: the Mac reconnects, hears where the relay stands,
  // sends again from there — the relay drops what it already has.
  const cur = (o, i) => ({ f: 'p1:s.jsonl', o, i })
  mac.ws.send(JSON.stringify({ type: 'event', kind: 'president', text: 'A', cur: cur(10, 0) }))
  check('a positioned event reaches the phone (seq 2), without its position', await until(() => phone.frames.some((f) => f.type === 'event' && f.seq === 2 && f.text === 'A' && !('cur' in f))))
  // An existing room needs no app key: a Mac paired before the gate keeps working.
  const mac2 = await open('mac', room, macKey)
  check('the registered Mac re-enters its room without the app key', mac2.status === 101)
  check('the reconnecting Mac hears the newest stored position', await until(() => mac2.frames.some((f) => f.type === 'resume' && f.cur?.o === 10 && f.cur.i === 0 && f.cur.f === 'p1:s.jsonl')))
  mac2.ws.send(JSON.stringify({ type: 'event', kind: 'president', text: 'A', cur: cur(10, 0) }))
  mac2.ws.send(JSON.stringify({ type: 'event', kind: 'president', text: 'B', cur: cur(20, 0) }))
  check('the resend after it is stored once (seq 3)', await until(() => phone.frames.some((f) => f.type === 'event' && f.seq === 3 && f.text === 'B')))
  check('...and the already stored one is not told twice', phone.frames.filter((f) => f.type === 'event' && f.text === 'A').length === 1)

  // The assistant's records: fetched from the Mac, sealed, never kept here.
  phone.ws.send(JSON.stringify({ type: 'assistant-history', box: 'CCCC' }))
  check('assistant-history reaches the Mac', await until(() => mac2.frames.some((f) => f.type === 'assistant-history' && f.box === 'CCCC')))
  mac2.ws.send(JSON.stringify({ type: 'assistant-history', box: 'AAAA' }))
  mac2.ws.send(JSON.stringify({ type: 'assistant', box: 'BBBB' }))
  check(
    'sealed assistant frames reach the phone, without a seq',
    await until(
      () =>
        phone.frames.some((f) => f.type === 'assistant' && f.box === 'BBBB' && !('seq' in f)) &&
        phone.frames.some((f) => f.type === 'assistant-history' && f.box === 'AAAA'),
    ),
  )
  // A proposal's button (phone → Mac) and the proposal list (Mac → phone): passed on, never kept.
  phone.ws.send(JSON.stringify({ type: 'assistant-proposal', box: 'DDDD' }))
  check('assistant-proposal reaches the Mac', await until(() => mac2.frames.some((f) => f.type === 'assistant-proposal' && f.box === 'DDDD')))
  mac2.ws.send(JSON.stringify({ type: 'assistant-proposals', box: 'EEEE' }))
  check('assistant-proposals reach the phone', await until(() => phone.frames.some((f) => f.type === 'assistant-proposals' && f.box === 'EEEE')))
  const replay = await open('phone', room, phoneKey, '?after=0')
  await until(() => replay.frames.some((f) => f.type === 'event' && f.seq === 3))
  await new Promise((r) => setTimeout(r, 300))
  check('...and are never kept for catch-up', !replay.frames.some((f) => f.type === 'assistant' || f.type === 'assistant-history' || f.type === 'assistant-proposals'))
  replay.ws.close()

  // Waking the phone (Push to Talk): the Mac says it can push, then the phone
  // hands over its token — passed to the Mac, never stored here.
  check('hello says pushToken:false before the Mac said it can push', phone.frames[0]?.pushToken === false)
  mac2.ws.send(JSON.stringify({ type: 'push-ready', on: true }))
  await sleep(300)
  const woken = await open('phone', room, phoneKey)
  check('...and pushToken:true once it did', await until(() => woken.frames[0]?.type === 'hello' && woken.frames[0].pushToken === true))
  const tok = { type: 'push-token', token: 'ab'.repeat(32), env: 'production', topic: 'com.x.phone.voip-ptt' }
  woken.ws.send(JSON.stringify(tok))
  check('the push token reaches the Mac', await until(() => mac2.frames.some((f) => f.type === 'push-token' && f.token === tok.token && f.env === 'production' && f.topic === tok.topic)))
  woken.ws.send(JSON.stringify({ type: 'push-token', token: null }))
  check('"forget it" reaches the Mac', await until(() => mac2.frames.some((f) => f.type === 'push-token' && f.token === null)))
  woken.ws.send(JSON.stringify({ ...tok, token: '../x' }))
  check('a malformed push token is refused', await until(() => woken.frames.some((f) => f.type === 'error' && f.code === 'bad-frame')))
  check('...and never reached the Mac', !mac2.frames.some((f) => f.token === '../x'))
  // A token that changes while the Mac is away is held and handed over on its return.
  mac2.ws.close()
  await until(() => woken.frames.some((f) => f.type === 'mac' && f.online === false))
  const asleep = await open('phone', room, phoneKey)
  check('with the Mac away, hello still says pushToken:true', await until(() => asleep.frames[0]?.type === 'hello' && asleep.frames[0].mac === false && asleep.frames[0].pushToken === true))
  asleep.ws.send(JSON.stringify({ ...tok, token: 'cd'.repeat(32) }))
  await sleep(300)
  check('...the token is not refused as mac-offline', !asleep.frames.some((f) => f.type === 'error'))
  const mac3 = await open('mac', room, macKey)
  check('...and reaches the Mac when it is back', await until(() => mac3.frames.some((f) => f.type === 'push-token' && f.token === 'cd'.repeat(32))))
  const mac4 = await open('mac', room, macKey)
  await sleep(500)
  check('...once only', !mac4.frames.some((f) => f.type === 'push-token'))
  await shut(woken, asleep)

  // Heard = erased: what the phone says it heard is gone from the relay.
  await shut(await open('phone', room, phoneKey, '?after=3&heard=2'))
  const again = await open('phone', room, phoneKey, '?after=0')
  await until(() => again.frames.some((f) => f.type === 'event'))
  await sleep(300)
  const seqs = again.frames.filter((f) => f.type === 'event').map((f) => f.seq)
  check('events the phone heard are erased; the rest stay', seqs.join() === '3')
  await shut(again)

  mac4.ws.send(JSON.stringify({ type: 'reset' }))
  check('reset closes the phones', await until(() => phone.closed !== null, 40000))
  check('after reset the old phone key is refused (401)', (await open('phone', room, phoneKey)).status === 401)
  check('after reset the old Mac key is refused too (401)', (await open('mac', room, macKey, '', { appKey: true })).status === 401)
  for (const b of [mac, mac2, phone]) b.ws.close()

  if (process.env.RELAY) {
    console.log('SKIP  expiry / limits (need short limits: local only)')
  } else {
    // A second relay with short limits (the RELAY_LIMITS override), so expiry
    // and caps can be watched within seconds.
    const w = await boot({
      ROOM_CREATE_KEY: APP_KEY,
      ROOM_CREATE: 'gated',
      // The idle limit is far from the event lifetime: an event gone within it
      // can only have gone by its own alarm, not by the idle sweep.
      RELAY_LIMITS: JSON.stringify({ eventTtlS: 3, roomIdleS: IDLE_S, phonesMax: 2, connectsPerMin: 12, macFramesPerMin: 20, phoneFramesPerMin: 10 }),
    })
    workers.push(w)
    const short = opener(`ws://${w.address}:${w.port}`)
    const pair = () => {
      const p = rand()
      return { p, m: rand(), r: sha(p) }
    }

    // Idle: a room nobody is connected to is emptied after roomIdleS.
    const idle = pair()
    const idleMac = await short('mac', idle.r, idle.m, '', { appKey: true })
    const idleCur = { f: 'p1:old.jsonl', o: 4096, i: 0 }
    idleMac.ws.send(JSON.stringify({ type: 'event', kind: 'president', text: 'kept?', cur: idleCur }))
    idleMac.ws.send(JSON.stringify({ type: 'projects', projects: [] }))
    await sleep(300)
    await shut(idleMac)
    const idleSince = Date.now()

    // In use: its Mac stays connected, and nobody dials in again until past the
    // idle limit (a new connection would itself count as use).
    const use = pair()
    const useMac = await short('mac', use.r, use.m, '', { appKey: true })
    const useSince = Date.now()
    useMac.ws.send(JSON.stringify({ type: 'projects', projects: [] }))
    useMac.ws.send(JSON.stringify({ type: 'event', kind: 'president', text: 'first' }))

    // Expiry: an event is gone after eventTtlS, heard or not.
    const ex = pair()
    const exMac = await short('mac', ex.r, ex.m, '', { appKey: true })
    const exSince = Date.now()
    exMac.ws.send(JSON.stringify({ type: 'event', kind: 'president', text: 'old' }))
    await sleep(300)
    const fresh = await short('phone', ex.r, ex.p, '?after=0')
    check('a just-stored event is there for catch-up', await until(() => fresh.frames.some((f) => f.type === 'event' && f.text === 'old')))
    await shut(fresh)
    let gone = false
    for (let i = 0; i < 4 && !gone; i++) {
      await sleep(3000)
      const p = await short('phone', ex.r, ex.p, '?after=0')
      await until(() => p.frames.length > 0)
      await sleep(300)
      gone = p.frames[0]?.type === 'hello' && p.frames[0].head === 1 && !p.frames.some((f) => f.type === 'event')
      await shut(p)
    }
    check('an expired event is erased (catch-up finds nothing)', gone)
    check('...by its own alarm, well before the idle limit', Date.now() - exSince < (IDLE_S - 4) * 1000)

    // Phone cap: phonesMax sockets at once, the next is refused.
    const cap = pair()
    const capMac = await short('mac', cap.r, cap.m, '', { appKey: true })
    const p1 = await short('phone', cap.r, cap.p)
    const p2 = await short('phone', cap.r, cap.p)
    const p3 = await short('phone', cap.r, cap.p)
    check('phones up to the cap connect', p1.status === 101 && p2.status === 101)
    check('a phone over the cap is refused (429)', p3.status === 429)
    await shut(p1, p2, capMac)

    // Frame rate: over macFramesPerMin the Mac is cut off (4029); the phone is counted apart.
    const rate = pair()
    const rateMac = await short('mac', rate.r, rate.m, '', { appKey: true })
    for (let i = 0; i < 25; i++) rateMac.ws.send(JSON.stringify({ type: 'event', kind: 'president', text: `n${i}` }))
    check('a sender over the frame rate is cut off (4029)', await until(() => rateMac.closed === 4029))
    // Connection rate: over connectsPerMin a new connection is refused.
    let refused = false
    for (let i = 0; i < 15 && !refused; i++) {
      const m = await short('mac', rate.r, rate.m)
      refused = m.status === 429
      m.ws.close()
    }
    check('connections over the per-room rate are refused (429)', refused)

    // The connected room survived its idle limit; the abandoned one did not.
    // A line said just before the in-use room's idle limit is still there just after it.
    await sleep(Math.max(0, useSince + (IDLE_S - 1) * 1000 - Date.now()))
    useMac.ws.send(JSON.stringify({ type: 'event', kind: 'president', text: 'recent' }))
    await sleep(Math.max(0, useSince + (IDLE_S + 1) * 1000 - Date.now()))
    const inUse = await short('phone', use.r, use.p, '?after=0')
    check(
      'a room still in use is kept past the idle limit (its latest line, seq and project list stay)',
      (await until(() => inUse.frames.some((f) => f.type === 'event' && f.text === 'recent' && f.seq === 2))) &&
        inUse.frames[0]?.type === 'hello' && inUse.frames[0].head === 2 && inUse.frames[0].projects !== null,
    )
    await shut(inUse, useMac)
    await sleep(Math.max(0, idleSince + (IDLE_S + 3) * 1000 - Date.now()))
    const back = await short('phone', idle.r, idle.p, '?after=0')
    await until(() => back.frames.length > 0)
    await sleep(300)
    check(
      'a room unused past the idle limit is emptied (no events, no project list, seq restarts)',
      back.status === 101 && back.frames[0]?.type === 'hello' && back.frames[0].head === 0 && back.frames[0].projects === null && back.frames.length === 1,
    )
    await shut(back)
    const idleBack = await short('mac', idle.r, idle.m)
    check('...but its own Mac comes back to it, even without the app key', idleBack.status === 101)
    // Emptied, it still knows how far the Mac's talk got: the Mac does not send
    // its old talk again as new (it would wake the phone to read it out).
    check(
      '...and hears the position of the newest line it had stored',
      await until(() => idleBack.frames.some((f) => f.type === 'resume' && f.cur?.f === idleCur.f && f.cur.o === idleCur.o && f.cur.i === 0)),
    )
    idleBack.ws.send(JSON.stringify({ type: 'event', kind: 'president', text: 'kept?', cur: idleCur }))
    await sleep(500)
    const after = await short('phone', idle.r, idle.p, '?after=0')
    await until(() => after.frames.length > 0)
    await sleep(300)
    check('...so that line sent again is not stored or told again', after.frames[0]?.head === 0 && !after.frames.some((f) => f.type === 'event'))
    await shut(after, idleBack)
    check('...and no other Mac key can take it', (await short('mac', idle.r, rand(), '', { appKey: true })).status === 401)
    exMac.ws.close()

    // Fail closed: a relay without ROOM_CREATE_KEY lets nobody create a room.
    const nk = await boot({ ROOM_CREATE: 'gated' })
    workers.push(nk)
    const nkOpen = opener(`ws://${nk.address}:${nk.port}`)
    const nkp = pair()
    check('no ROOM_CREATE_KEY: a Mac without an app key cannot create a room (401)', (await nkOpen('mac', nkp.r, nkp.m)).status === 401)
    check('no ROOM_CREATE_KEY: a Mac with any app key cannot either (401)', (await nkOpen('mac', nkp.r, nkp.m, '', { appKey: true })).status === 401)

    // Rollout mode (ROOM_CREATE "open"): any Mac may still create a room.
    const ow = await boot({ ROOM_CREATE_KEY: APP_KEY, ROOM_CREATE: 'open' })
    workers.push(ow)
    const op = pair()
    check('rollout mode "open": a Mac without the app key still creates a room', (await opener(`ws://${ow.address}:${ow.port}`)('mac', op.r, op.m)).status === 101)
  }
} finally {
  for (const w of workers) await w.stop()
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)

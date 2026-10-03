// Sealed phone link (v2, docs/PHONE_LINK.md "Sealed frames"). Runs the REAL
// relay room (worker/src/phoneRelay.ts) on an in-memory storage, fed with what
// the REAL Mac end sends, and asserts what the relay ends up holding and what
// reaches the desk — never "a function was called".
import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac, hkdfSync, randomBytes } from 'node:crypto'

const h = vi.hoisted(() => ({ file: '', files: {} as Record<string, string>, projects: [] as { id: string; path: string; displayName?: string }[] }))
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}))
vi.mock('./swarmGate', () => ({ isSwarmLocalOwnerUnlocked: async () => true }))
vi.mock('./roles', () => ({ getCustomTabRole: async () => null }))
vi.mock('./store', async (orig) => ({ ...(await orig<typeof import('./store')>()), getSettings: async () => ({ projects: h.projects }) }))
vi.mock('./swarmSessions', () => ({ readSwarmSessions: async (p: string) => ({ supply: { cwd: p, sessionId: 's1' } }) }))
vi.mock('./transcript', () => ({ sessionJsonlPath: (cwd: string) => h.files[cwd] ?? h.file }))
vi.mock('./terminal', async (orig) => ({ ...(await orig<typeof import('./terminal')>()), listLiveDesksIn: () => [{ id: 'd1' }] }))
;(globalThis as Record<string, unknown>).WebSocketRequestResponsePair = class {}

// The relay compiles under worker/tsconfig.json (Workers types), not the app's:
// loaded by a path tsc does not follow, so only vitest (with the mock above) runs it.
const RELAY_MODULE = '../../../worker/src/phoneRelay'
type Room = { webSocketMessage(ws: unknown, msg: string): Promise<void> }
import { __testConnect, outerFrame, handleRelayFrame, LEGACY_V1_UNTIL, pairingCode, pumpTranscript, readPhoneLinkConfig, SEALED_MAX_AGE_MS, startPhoneLink, stopPhoneLink, tick, __testLinkState, type PhoneLinkConfig } from './phoneLink'
import { e2eKeyOf, open, seal } from './phoneLinkSeal'
import { openGroundHome } from './paths'
import { setLockdownCache } from './lockdown'
import { flushSupplyNotices, resetSupplyNoticeState } from './supplyNotice'
import { appendAssistantEntries, clearAssistantLog, clearAssistantMemory, writeAssistantMemory } from './assistantMemory'

const PROJECT = '/repo/alpha'
const E2E = randomBytes(32).toString('base64url')
const KEY = e2eKeyOf(E2E)!
const CFG: PhoneLinkConfig = { v: 2, relayUrl: 'https://relay.test', macKey: 'm'.repeat(43), phoneKey: 'p'.repeat(43), e2eKey: E2E, projectId: 'p1' }
const SECRETS = ['月曜に出す秘密の計画', '極秘プロジェクト', '今の状況は?']

const dir = mkdtempSync(join(tmpdir(), 'og-phone-sealed-'))
const cfgFile = () => join(openGroundHome(), 'phone-link.json')
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  resetSupplyNoticeState()
  setLockdownCache(false)
  h.projects = [{ id: 'p1', path: PROJECT, displayName: '極秘プロジェクト' }]
  h.files = {}
  h.file = join(dir, `${Math.random()}.jsonl`)
  writeFileSync(h.file, '')
})
afterEach(() => {
  vi.useRealTimers()
  stopPhoneLink()
  rmSync(cfgFile(), { force: true })
})

/** The Mac's socket: every frame it sends, as the relay receives it. */
const macSocket = () => {
  const wire: string[] = []
  return { wire, sock: { readyState: 1, send: (s: string) => void wire.push(s) } }
}
const fakeDesk = () => {
  const writes: string[] = []
  let box = ''
  return {
    writes,
    deps: {
      desks: () => [{ id: 'd1', cwd: PROJECT }],
      screen: () => ['⏺ done.', '', '─'.repeat(40), `❯ ${box}`, '─'.repeat(40), '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n'),
      write: (_id: string, data: string) => {
        if (data === '\r') box = ''
        else writes.push((box = data.replace(/\x1b\[20[01]~/g, '')))
        return true
      },
      sleep: async () => {},
    },
  }
}
/** A desk whose Enter is swallowed until the owner clears the box by hand. */
const stubbornDesk = () => {
  let box = ''
  let swallow = true
  return {
    ownerClears: () => {
      box = ''
      swallow = false
    },
    deps: {
      desks: () => [{ id: 'd1', cwd: PROJECT }],
      screen: () => ['⏺ done.', '', '─'.repeat(40), `❯ ${box}`, '─'.repeat(40), '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n'),
      write: (_id: string, data: string) => {
        if (data !== '\r') box = data.replace(/\x1b\[20[01]~/g, '')
        else if (!swallow) box = ''
        return true
      },
      sleep: async () => {},
    },
  }
}
/** A phone frame as the iPhone app seals it. */
const phoneSays = (inner: Record<string, unknown>, key = KEY) => ({ type: inner.type, ...(inner.id ? { id: inner.id } : {}), box: seal(key, 'p2m', inner) })
const opened = (wire: string[]) => wire.map((s) => JSON.parse(s)).map((f) => (f.box ? { ...f, inner: open(KEY, 'm2p', f.box) } : f))

/** The real relay room on an in-memory storage, with one Mac and one phone socket. */
const relayRoom = async () => {
  const { OgPhoneRelay } = (await import(/* @vite-ignore */ RELAY_MODULE)) as { OgPhoneRelay: new (ctx: unknown, env: unknown) => Room }
  const store = new Map<string, unknown>()
  const mk = (tag: string) => ({ tag, got: [] as string[], send(s: string) { this.got.push(s) }, close() {} })
  const mac = mk('mac')
  const phone = mk('phone')
  const ctx = {
    setWebSocketAutoResponse() {},
    getWebSockets: (tag: string) => [mac, phone].filter((w) => w.tag === tag),
    getTags: (ws: { tag: string }) => [ws.tag],
    storage: {
      get: async (k: string) => structuredClone(store.get(k)),
      put: async (k: string | Record<string, unknown>, v?: unknown) => {
        for (const [a, b] of typeof k === 'string' ? [[k, v] as const] : Object.entries(k)) store.set(a, structuredClone(b))
      },
      delete: async (k: string) => store.delete(k),
      list: async ({ start, end }: { start: string; end: string }) => new Map(Array.from(store).filter(([k]) => k >= start && k < end).sort()),
      deleteAll: async () => store.clear(),
      // The expiry alarm (kept apart: the test reads `store` as what the room holds).
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => void (alarm = at),
    },
  }
  let alarm: number | null = null
  const room = new OgPhoneRelay(ctx, {})
  return { store, phone, fromMac: (s: string) => room.webSocketMessage(mac, s) }
}

const line = (o: unknown) => JSON.stringify(o) + '\n'

describe('sealed link — what the relay holds', () => {
  it('the relay stores and passes only ciphertext; the phone opens every word', async () => {
    const { wire, sock } = macSocket()
    const st = __testLinkState(CFG, sock)
    const desk = fakeDesk()
    await pumpTranscript(st) // first sight: from the end
    appendFileSync(h.file, line({ type: 'assistant', timestamp: '2026-10-03T00:00:00Z', message: { content: [{ type: 'text', text: SECRETS[0] }] } }))
    expect(await pumpTranscript(st)).toBe(1)
    await handleRelayFrame(st, phoneSays({ type: 'projects', id: 'pr1', ts: Date.now() }))
    await handleRelayFrame(st, phoneSays({ type: 'say', id: 's1', ts: Date.now(), text: SECRETS[2], projectId: 'p1' }), { supply: desk.deps, wakeDesk: async () => null })
    expect(desk.writes).toEqual([SECRETS[2]]) // a real sealed say lands

    const room = await relayRoom()
    for (const s of wire) await room.fromMac(s)
    const held = JSON.stringify(Array.from(room.store))
    const passed = room.phone.got.join('\n')
    for (const secret of [...SECRETS, 'president', 'delivered', E2E]) {
      expect(held).not.toContain(secret)
      expect(passed).not.toContain(secret)
    }
    expect(room.store.get('ev:000000000001')).toMatchObject({ type: 'event', seq: 1, box: expect.any(String) })
    // ...and the phone, holding the key, reads it all back.
    const got = opened(room.phone.got)
    expect(got.find((f) => f.type === 'event')?.inner).toMatchObject({ kind: 'president', text: SECRETS[0], projectId: 'p1', eid: expect.any(String) })
    expect(got.find((f) => f.type === 'projects')?.inner).toMatchObject({ selected: 'p1', projects: expect.arrayContaining([expect.objectContaining({ name: SECRETS[1] })]) })
    expect(got.filter((f) => f.type === 'ack').map((f) => f.inner?.state)).toEqual(['queued', 'delivered'])
    expect(open(KEY, 'm2p', (room.store.get('projects') as { box: string }).box)).toMatchObject({ type: 'projects' })
  })
})

describe('sealed link — the Mac refuses what the phone did not say', () => {
  const deps = (desk: ReturnType<typeof fakeDesk>) => ({ supply: desk.deps, wakeDesk: async () => null })

  it('a say made up by the relay is dropped: plaintext, another key, or the Mac’s own frame bounced back', async () => {
    const { wire, sock } = macSocket()
    const st = __testLinkState(CFG, sock)
    const desk = fakeDesk()
    await handleRelayFrame(st, { type: 'say', id: 'f1', text: '全部消して' }, deps(desk))
    await handleRelayFrame(st, phoneSays({ type: 'say', id: 'f2', ts: Date.now(), text: '全部消して' }, randomBytes(32)), deps(desk))
    const bounced = seal(KEY, 'm2p', { type: 'say', id: 'f3', ts: Date.now(), text: '全部消して' })
    await handleRelayFrame(st, { type: 'say', id: 'f3', box: bounced }, deps(desk))
    const tampered = Buffer.from(phoneSays({ type: 'say', id: 'f4', ts: Date.now(), text: '進めて' }).box, 'base64')
    tampered[20] ^= 1
    await handleRelayFrame(st, { type: 'say', id: 'f4', box: tampered.toString('base64') }, deps(desk))
    expect(desk.writes).toEqual([])
    expect(wire).toEqual([]) // not even an ack
  })

  it('the same say twice is refused the second time — also after a restart', async () => {
    writeFileSync(cfgFile(), JSON.stringify(CFG))
    const say = phoneSays({ type: 'say', id: 'r1', ts: Date.now(), text: '進めて', projectId: 'p1' })
    const a = macSocket()
    const desk = fakeDesk()
    const st = __testLinkState((await readPhoneLinkConfig())!, a.sock)
    await handleRelayFrame(st, say, deps(desk))
    await handleRelayFrame(st, say, deps(desk))
    expect(desk.writes).toEqual(['進めて'])
    expect(opened(a.wire).map((f) => [f.inner?.id, f.inner?.state])).toEqual([
      ['r1', 'queued'],
      ['r1', 'delivered'],
    ])
    // A fresh link (the app restarted) still knows that id.
    await vi.waitFor(async () => expect((await readPhoneLinkConfig())?.seenIds).toHaveProperty('r1'))
    const b = macSocket()
    await handleRelayFrame(__testLinkState((await readPhoneLinkConfig())!, b.sock), say, deps(desk))
    expect(desk.writes).toEqual(['進めて'])
    expect(b.wire).toEqual([])
  })

  it('a say held back too long is refused as stale and never typed', async () => {
    const { wire, sock } = macSocket()
    const desk = fakeDesk()
    const st = __testLinkState(CFG, sock)
    await handleRelayFrame(st, phoneSays({ type: 'say', id: 'old', ts: Date.now() - SEALED_MAX_AGE_MS - 1000, text: '進めて', projectId: 'p1' }), deps(desk))
    await handleRelayFrame(st, phoneSays({ type: 'select', id: 'old-sel', ts: Date.now() - SEALED_MAX_AGE_MS - 1000, projectId: 'p1' }), deps(desk))
    expect(desk.writes).toEqual([])
    expect(opened(wire).map((f) => f.inner)).toMatchObject([{ type: 'ack', id: 'old', state: 'rejected', reason: 'stale' }])
  })
})

describe('sealed link — the relay cannot steer a say', () => {
  it('a replayed select is dropped, and a say without its project is refused', async () => {
    h.projects = [
      { id: 'p1', path: PROJECT },
      { id: 'p2', path: '/repo/beta' },
    ]
    const { wire, sock } = macSocket()
    const desk = fakeDesk()
    const st = __testLinkState(CFG, sock)
    const toBeta = phoneSays({ type: 'select', id: 'sel-1', ts: Date.now(), projectId: 'p2' })
    await handleRelayFrame(st, toBeta)
    await handleRelayFrame(st, phoneSays({ type: 'select', id: 'sel-2', ts: Date.now(), projectId: 'p1' }))
    await handleRelayFrame(st, toBeta) // the relay plays the old one again
    expect(st.cfg.projectId).toBe('p1')
    await handleRelayFrame(st, phoneSays({ type: 'say', id: 'np', ts: Date.now(), text: '出荷して' }), { supply: desk.deps, wakeDesk: async () => null })
    expect(desk.writes).toEqual([])
    expect(opened(wire).filter((f) => f.type === 'ack').map((f) => f.inner)).toMatchObject([{ type: 'ack', id: 'np', state: 'rejected', reason: 'no-project' }])
  })
})

describe('sealed link — what the phone can rely on (v2)', () => {
  const user = (text: string) => line({ type: 'user', timestamp: '2026-10-03T00:00:00Z', message: { content: text } })
  const president = (text: string) => line({ type: 'assistant', timestamp: '2026-10-03T00:00:00Z', message: { content: [{ type: 'text', text }] } })

  it('the owner echo of a sealed say carries that say id — president desk and assistant', async () => {
    const { wire, sock } = macSocket()
    const st = __testLinkState(CFG, sock)
    await pumpTranscript(st)
    await handleRelayFrame(st, phoneSays({ type: 'say', id: 'echo-1', ts: Date.now(), text: '進めて', projectId: 'p1' }), { supply: fakeDesk().deps, wakeDesk: async () => null })
    appendFileSync(h.file, user('進めて'))
    await pumpTranscript(st)
    await handleRelayFrame(st, phoneSays({ type: 'say', id: 'echo-a', ts: Date.now(), text: '全体どう?', projectId: 'assistant' }), {
      assistant: async () => ({ reply: '順調です' }),
    })
    const owner = opened(wire)
      .filter((f) => f.type === 'event' && f.inner?.kind === 'owner')
      .map((f) => f.inner)
    expect(owner.map((e) => [e?.projectId, e?.id])).toEqual([
      ['p1', 'echo-1'],
      ['assistant', 'echo-a'],
    ])
    for (const e of owner) expect(e?.eid).toEqual(expect.any(String))
  })

  it('a Mac resend of the same line keeps its eid; the relay sees a tag, not the project, as the file', () => {
    const ev = { type: 'event', projectId: 'p1', kind: 'president', text: 'x', cur: { f: 'p1:s1.jsonl', o: 120, i: 0 } }
    const a = outerFrame(CFG, ev)!
    const b = outerFrame(CFG, ev)!
    const c = outerFrame(CFG, { ...ev, cur: { f: 'p1:s1.jsonl', o: 240, i: 0 } })!
    const eid = (o: Record<string, unknown>) => open(KEY, 'm2p', o.box)?.eid
    expect(eid(a)).toBe(eid(b))
    expect(eid(a)).not.toBe(eid(c))
    expect(a.box).not.toBe(b.box) // a fresh nonce every time
    expect(a.cur).toEqual({ f: expect.any(String), o: 120, i: 0 })
    expect(JSON.stringify(a.cur)).not.toContain('p1')
    expect((a.cur as { f: string }).f).toBe((c.cur as { f: string }).f) // still comparable by the relay
  })

  it('a resume names the tagged file and rewinds to just that event', async () => {
    const { wire, sock } = macSocket()
    const st = __testLinkState(CFG, sock)
    await pumpTranscript(st)
    appendFileSync(h.file, president('一') + president('二') + president('三'))
    expect(await pumpTranscript(st)).toBe(3)
    // The relay stored up to the second (a new connection is answered with its cur).
    await handleRelayFrame(st, { type: 'resume', cur: JSON.parse(wire[1]).cur })
    expect(await pumpTranscript(st)).toBe(2) // the second and third again, not all three
    const eids = opened(wire).map((f) => f.inner?.eid)
    expect(eids.slice(3)).toEqual(eids.slice(1, 3)) // same eids: the phone skips them
  })

  it('every sealed frame to the phone carries a strictly increasing sent', async () => {
    const { wire, sock } = macSocket()
    const st = __testLinkState(CFG, sock)
    for (const id of ['q1', 'q2', 'q3']) await handleRelayFrame(st, phoneSays({ type: 'projects', id, ts: Date.now() }))
    const sent = opened(wire).map((f) => f.inner?.sent as number)
    expect(sent).toHaveLength(3)
    for (let i = 1; i < sent.length; i++) expect(sent[i]).toBeGreaterThan(sent[i - 1])
  })

  it('a say whose id cannot be saved is not typed (fail closed)', async () => {
    mkdirSync(join(cfgFile(), 'blocked'), { recursive: true }) // the config path is a directory: every write fails
    try {
      const desk = fakeDesk()
      const { wire, sock } = macSocket()
      await handleRelayFrame(__testLinkState(CFG, sock), phoneSays({ type: 'say', id: 'w1', ts: Date.now(), text: '進めて', projectId: 'p1' }), {
        supply: desk.deps,
        wakeDesk: async () => null,
      })
      expect(desk.writes).toEqual([])
      // …and the phone is told so (sealed), not left waiting for nothing.
      expect(opened(wire).map((f) => [f.box !== undefined, f.inner])).toEqual([
        [true, expect.objectContaining({ type: 'ack', id: 'w1', state: 'rejected', reason: 'mac-error' })],
      ])
    } finally {
      rmSync(cfgFile(), { recursive: true, force: true })
    }
  })

  it('two text blocks on one transcript line get different eids', () => {
    const ev = { type: 'event', projectId: 'p1', kind: 'president', text: 'x' }
    const a = outerFrame(CFG, { ...ev, cur: { f: 'p1:s1.jsonl', o: 120, i: 0 } })!
    const b = outerFrame(CFG, { ...ev, cur: { f: 'p1:s1.jsonl', o: 120, i: 1 } })!
    expect(open(KEY, 'm2p', a.box)?.eid).not.toBe(open(KEY, 'm2p', b.box)?.eid)
  })

  it('the keyed tags use a key of their own, not the AES-GCM key', () => {
    const f = 'p1:s1.jsonl'
    const outer = outerFrame(CFG, { type: 'event', projectId: 'p1', kind: 'president', text: 'x', cur: { f, o: 1, i: 0 } })!
    const underAesKey = createHmac('sha256', KEY).update(`og-phone-link/v2 cur|${f}`, 'utf8').digest('base64url').slice(0, 22)
    const tagKey = Buffer.from(hkdfSync('sha256', KEY, '', 'og-phone-link/v2 tag', 32))
    expect((outer.cur as { f: string }).f).not.toBe(underAesKey)
    expect((outer.cur as { f: string }).f).toBe(createHmac('sha256', tagKey).update(`og-phone-link/v2 cur|${f}`, 'utf8').digest('base64url').slice(0, 22))
  })

  it('an owner echo gets its say id although claude dropped an invisible character (v2)', async () => {
    const { wire, sock } = macSocket()
    const st = __testLinkState(CFG, sock)
    await pumpTranscript(st)
    await handleRelayFrame(st, phoneSays({ type: 'say', id: 'inv', ts: Date.now(), text: '進め\u200bて', projectId: 'p1' }), { supply: fakeDesk().deps, wakeDesk: async () => null })
    appendFileSync(h.file, user('進めて'))
    await pumpTranscript(st)
    expect(opened(wire).filter((f) => f.inner?.kind === 'owner').map((f) => f.inner?.id)).toEqual(['inv'])
  })

  it('a say cleared from the box never lends its id to a later one with the same words (v2)', async () => {
    const { wire, sock } = macSocket()
    const st = __testLinkState(CFG, sock)
    const desk = stubbornDesk()
    await pumpTranscript(st)
    await handleRelayFrame(st, phoneSays({ type: 'say', id: 'lost', ts: Date.now(), text: 'はい', projectId: 'p1' }), { supply: desk.deps, wakeDesk: async () => null })
    desk.ownerClears()
    await handleRelayFrame(st, phoneSays({ type: 'say', id: 's2', ts: Date.now(), text: 'はい', projectId: 'p1' }), { supply: desk.deps, wakeDesk: async () => null })
    await flushSupplyNotices(desk.deps)
    appendFileSync(h.file, user('はい'))
    await pumpTranscript(st)
    const inner = opened(wire).map((f) => f.inner)
    expect(inner.filter((f) => f?.type === 'ack' && f.state === 'delivered').map((f) => [f?.id, f?.heard])).toEqual([
      ['lost', false],
      ['s2', true],
    ])
    expect(inner.filter((f) => f?.kind === 'owner').map((f) => f?.id)).toEqual(['s2'])
  })

  const say = (id: string, text: string, projectId = 'p1') => phoneSays({ type: 'say', id, ts: Date.now(), text, projectId })
  const ownerIds = (wire: string[]) =>
    opened(wire)
      .filter((f) => f.inner?.kind === 'owner')
      .map((f) => [f.inner?.projectId, f.inner?.id])

  it('emoji VS16 / ZWJ stay in the transcript: the echo still gets the id (v2)', async () => {
    const { wire, sock } = macSocket()
    const st = __testLinkState(CFG, sock)
    await pumpTranscript(st)
    const words = ['了解\u2764\uFE0F', '家族\u{1F468}\u200D\u{1F469}\u200D\u{1F467}']
    for (let i = 0; i < words.length; i++) await handleRelayFrame(st, say(`e${i}`, words[i]), { supply: fakeDesk().deps, wakeDesk: async () => null })
    appendFileSync(h.file, words.map((w) => user(w)).join(''))
    await pumpTranscript(st)
    expect(ownerIds(wire)).toEqual([
      ['p1', 'e0'],
      ['p1', 'e1'],
    ])
  })

  it('a say not echoed before work mode went on never lends its id to a later one (v2)', async () => {
    const { wire, sock } = macSocket()
    const st = __testLinkState(CFG, Object.assign(sock, { terminate: () => {} }))
    st.lastHeard = Date.now()
    await pumpTranscript(st)
    await handleRelayFrame(st, say('old', 'はい'), { supply: fakeDesk().deps, wakeDesk: async () => null })
    setLockdownCache(true)
    await tick(st)
    setLockdownCache(false)
    await pumpTranscript(st)
    await handleRelayFrame(st, say('new', 'はい'), { supply: fakeDesk().deps, wakeDesk: async () => null })
    appendFileSync(h.file, user('はい'))
    await pumpTranscript(st)
    expect(ownerIds(wire)).toEqual([['p1', 'new']])
  })

  const twoProjects = () => {
    h.projects = [
      { id: 'p1', path: PROJECT },
      { id: 'p2', path: '/repo/beta' },
    ]
    h.files = { [PROJECT]: join(dir, `${Math.random()}-a.jsonl`), '/repo/beta': join(dir, `${Math.random()}-b.jsonl`) }
    for (const f of Object.values(h.files)) writeFileSync(f, '')
  }

  it('switching projects drops the says to the one left that were not echoed yet (v2)', async () => {
    twoProjects()
    const { wire, sock } = macSocket()
    const st = __testLinkState(CFG, sock)
    await pumpTranscript(st)
    await handleRelayFrame(st, say('never', 'はい'), { supply: fakeDesk().deps, wakeDesk: async () => null })
    for (const projectId of ['p2', 'p1']) await handleRelayFrame(st, phoneSays({ type: 'select', id: `sel-${projectId}`, ts: Date.now(), projectId }))
    await pumpTranscript(st)
    appendFileSync(h.files[PROJECT], user('はい')) // typed at the Mac
    await pumpTranscript(st)
    expect(ownerIds(wire)).toEqual([['p1', undefined]])
  })

  it("another project's say never lends its id to this project's echo (v2)", async () => {
    twoProjects()
    const { wire, sock } = macSocket()
    const st = __testLinkState(CFG, sock)
    await handleRelayFrame(st, say('beta', 'はい', 'p2'), { supply: fakeDesk().deps, wakeDesk: async () => null })
    h.projects = [{ id: 'p1', path: PROJECT }] // p2 unregistered: the link falls back to p1 without a select
    await pumpTranscript(st)
    appendFileSync(h.files[PROJECT], user('はい')) // typed at the Mac
    await pumpTranscript(st)
    expect(ownerIds(wire)).toEqual([['p1', undefined]])
  })
})

describe('sealed link — pairing and the old format', () => {
  it('the pairing code carries the e2e key; a v2 config without a valid one is not a pairing', async () => {
    const c = JSON.parse(Buffer.from(pairingCode(CFG), 'base64url').toString())
    expect(c).toEqual({ v: 2, url: expect.stringMatching(/^wss:\/\/relay\.test\/v1\/[0-9a-f]{64}\/phone$/), key: CFG.phoneKey, e2e: E2E })
    writeFileSync(cfgFile(), JSON.stringify({ ...CFG, e2eKey: 'short' }))
    expect(await readPhoneLinkConfig()).toBeNull()
  })

  it('a plaintext (v1) pairing stops connecting at LEGACY_V1_UNTIL', async () => {
    const { e2eKey: _k, ...v1 } = { ...CFG, v: 1 }
    writeFileSync(cfgFile(), JSON.stringify(v1))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(LEGACY_V1_UNTIL)
    expect(await startPhoneLink()).toBe(false)
    vi.setSystemTime(LEGACY_V1_UNTIL - 1)
    expect(await startPhoneLink()).toBe(true)
    // ...and a link already running stops dialing once the date has passed.
    const { sock } = macSocket()
    const st = __testLinkState(v1 as PhoneLinkConfig, sock)
    st.ws = null
    st.stopped = false
    vi.setSystemTime(LEGACY_V1_UNTIL)
    __testConnect(st)
    expect(st.ws).toBeNull()
    expect(st.stopped).toBe(true)
  })

  it('the test vectors in docs/PHONE_LINK.md are what this end seals', () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
    const nonce = Buffer.from(Array.from({ length: 12 }, (_, i) => 0xa0 + i))
    expect(key.toString('base64url')).toBe('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8')
    expect(seal(key, 'p2m', { type: 'say', id: 'vec-1', ts: 1790000000000, text: '今どうなってる?' }, nonce)).toBe(
      'oKGio6SlpqeoqaqrnToIVDWuIIVAFuaqJVbitxSOYzLk0iFBrSwKpAvYVzvjQX7PnxJjDW+sNPg5VqGNImMyaljy/sXLvYr3R/EDUzUWZu6TRmVGF2B0J62zcTsid6CGROXtZM/4Z0XKQw==',
    )
    // Another nonce for the second vector: a nonce is never used twice under one key.
    const nonce2 = Buffer.from(Array.from({ length: 12 }, (_, i) => 0xb0 + i))
    expect(seal(key, 'm2p', { type: 'event', projectId: 'p1', kind: 'president', text: '了解しました', at: 1790000000123 }, nonce2)).toBe(
      'sLGys7S1tre4ubq74ncu0pyomWVlneHHoymq7qZMO71/S+xBF6qgy37ywzQpaUhTDbqEgocr0i9P0ObQQxk16zlPJ4g5qFYS4CGmFxVL3TWdX+dk+l01vR+ZwB1k8b2QkklC5MXLSKAbaT+OUZMD39ZHqORZKUS8RDFOsuy7pg==',
    )
    // Sealed by CryptoKit (AES.GCM.seal, macOS 27 / Swift 6.4) — the phone's side.
    expect(
      open(key, 'p2m', 'tRfEJdCHeZN2yLj5h6NcHO1ebaEfeA00Dp8nSEw0uf8hqQ6cI+AxJR9NX2T5vGgfh3Vi7uWmlnwY2xrRz/SSqPQWNnNYfPyHz1aC8c/FiQIvNMJGdP8Ohit62ykSuPgiwr9V2B+1BljiT1o='),
    ).toEqual({ type: 'say', id: 'from-swift', ts: 1790000000000, text: 'スイフトから' })
  })
})

describe('sealed link — the assistant and its records (v2)', () => {
  const RECORD = ['猫の名前はミケ', '覚えたよ', 'オーナーの猫=ミケ', '秘密の質問', '秘密の答え', '秘密のカード']
  beforeEach(async () => {
    await clearAssistantLog()
    await clearAssistantMemory()
  })

  it('the phone fetches the log and memo from the Mac: sealed, passed on by the relay, kept nowhere on it', async () => {
    const { wire, sock } = macSocket()
    const st = __testLinkState(CFG, sock)
    await appendAssistantEntries([
      { at: Date.now() - 60_000, who: 'owner', text: RECORD[0], via: 'phone' },
      { at: Date.now() - 50_000, who: 'assistant', text: RECORD[1], via: 'phone' },
    ])
    await writeAssistantMemory(RECORD[2], 4000)
    await handleRelayFrame(st, phoneSays({ type: 'assistant-history', id: 'h1', ts: Date.now() }))
    expect(wire.map((s) => Object.keys(JSON.parse(s)).sort())).toEqual([['box', 'type']])
    const room = await relayRoom()
    for (const s of wire) await room.fromMac(s)
    const held = JSON.stringify(Array.from(room.store))
    for (const secret of RECORD.slice(0, 3)) {
      expect(held).not.toContain(secret)
      expect(room.phone.got.join('\n')).not.toContain(secret)
    }
    expect(Array.from(room.store.keys()).some((k) => k.startsWith('ev:'))).toBe(false) // not kept for catch-up
    const page = opened(room.phone.got)[0].inner as Record<string, unknown> & { entries: { text: string }[] }
    expect(page).toMatchObject({ type: 'assistant-history', id: 'h1', memory: RECORD[2], more: false, logDays: 30, memoryChars: 4000 })
    expect(page.entries.map((e) => e.text)).toEqual(RECORD.slice(0, 2))
    // From now on the assistant's talk goes as `assistant` frames — a restart remembers.
    expect((await readPhoneLinkConfig())?.assistantDirect).toBe(true)
  })

  it('after that, a say to the assistant and its answer cross sealed and the relay keeps none of it', async () => {
    const { wire, sock } = macSocket()
    const st = __testLinkState({ ...CFG, assistantDirect: true }, sock)
    const card = { projectId: 'p1', taskId: 't1', title: RECORD[5] }
    await handleRelayFrame(st, phoneSays({ type: 'say', id: 'a1', ts: Date.now(), text: RECORD[3], projectId: 'assistant' }), {
      assistant: async () => ({ reply: RECORD[4], card }),
    })
    const room = await relayRoom()
    for (const s of wire) await room.fromMac(s)
    const held = JSON.stringify(Array.from(room.store))
    for (const secret of RECORD.slice(3)) {
      expect(wire.join('\n')).not.toContain(secret)
      expect(held).not.toContain(secret)
    }
    expect(Array.from(room.store.keys()).some((k) => k.startsWith('ev:'))).toBe(false)
    const got = opened(room.phone.got)
    expect(got.map((f) => [f.type, Object.keys(f).filter((k) => k !== 'inner').sort().join()])).toEqual([
      ['ack', 'box,type'],
      ['assistant', 'box,type'],
      ['ack', 'box,type'],
      ['assistant', 'box,type'],
    ])
    expect(got.filter((f) => f.type === 'assistant').map((f) => [f.inner?.kind, f.inner?.text, f.inner?.id])).toEqual([
      ['owner', RECORD[3], 'a1'],
      ['assistant', RECORD[4], undefined],
    ])
    // Each carries its own mark, so a phone that hears one twice reads it once.
    const eids = got.filter((f) => f.type === 'assistant').map((f) => f.inner?.eid)
    expect(eids).toEqual([expect.any(String), expect.any(String)])
    expect(new Set(eids).size).toBe(2)
    expect(got.find((f) => f.inner?.state === 'delivered')?.inner?.card).toEqual(card)
  })

  it('before the phone ever fetched, the assistant still talks in sealed events (no plain word on the relay)', async () => {
    const { wire, sock } = macSocket()
    const st = __testLinkState(CFG, sock)
    await handleRelayFrame(st, phoneSays({ type: 'say', id: 'b1', ts: Date.now(), text: RECORD[3], projectId: 'assistant' }), {
      assistant: async () => ({ reply: RECORD[4] }),
    })
    expect(wire.join('\n')).not.toMatch(/秘密/)
    expect(opened(wire).filter((f) => f.type === 'event').map((f) => f.inner?.text)).toEqual([RECORD[3], RECORD[4]])
  })

  it('a long log comes in pages that fit the relay frame, newest first, nothing lost', async () => {
    const { wire, sock } = macSocket()
    const st = __testLinkState(CFG, sock)
    const t0 = Date.now() - 3_600_000
    await appendAssistantEntries(Array.from({ length: 60 }, (_, i) => ({ at: t0 + i, who: 'owner' as const, text: `${i}:` + 'あ'.repeat(1900), via: 'phone' as const })))
    const got: string[] = []
    let before: number | undefined
    for (let n = 0; n < 20; n++) {
      wire.length = 0
      await handleRelayFrame(st, phoneSays({ type: 'assistant-history', id: `p${n}`, ts: Date.now(), ...(before !== undefined ? { before } : {}) }))
      expect(wire[0].length).toBeLessThan(64 * 1024) // the relay's Mac frame limit
      const page = opened(wire)[0].inner as { entries: { at: number; text: string }[]; more: boolean }
      got.unshift(...page.entries.map((e) => e.text.split(':')[0]))
      if (!page.more) break
      before = page.entries[0].at
    }
    expect(got).toEqual(Array.from({ length: 60 }, (_, i) => String(i)))
  })

  it('a plaintext (v1) pairing never gets the records — it is told to pair again', async () => {
    const { wire, sock } = macSocket()
    const { e2eKey: _k, ...v1 } = { ...CFG, v: 1 as const }
    const st = __testLinkState(v1, sock)
    await appendAssistantEntries([{ at: Date.now() - 1000, who: 'owner', text: RECORD[0], via: 'phone' }])
    await writeAssistantMemory(RECORD[2], 4000)
    await handleRelayFrame(st, { type: 'assistant-history', id: 'v1' })
    expect(wire.map((s) => JSON.parse(s))).toEqual([{ type: 'assistant-history', id: 'v1', error: 'pair-again' }])
    expect(st.cfg.assistantDirect).toBeUndefined()
  })

  it('under work mode the records are not sent', async () => {
    const { wire, sock } = macSocket()
    const st = __testLinkState(CFG, sock)
    const frame = phoneSays({ type: 'assistant-history', id: 'w1', ts: Date.now() })
    setLockdownCache(true)
    await handleRelayFrame(st, frame)
    setLockdownCache(false)
    expect(wire).toEqual([])
  })
})

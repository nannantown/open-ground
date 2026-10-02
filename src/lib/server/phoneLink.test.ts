// Phone link, Mac end (phoneLink.ts). Asserts what reaches the DESK and what
// reaches the PHONE (the frames sent), never "a function was called".
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({ owner: true, desk: false, file: '', files: {} as Record<string, string>, projects: [] as { id: string; path: string }[] }))
vi.mock('./swarmGate', () => ({ isSwarmLocalOwnerUnlocked: async () => h.owner }))
vi.mock('./roles', () => ({ getCustomTabRole: async () => null }))
vi.mock('./store', async (orig) => ({
  ...(await orig<typeof import('./store')>()),
  getSettings: async () => ({ projects: h.projects }),
}))
vi.mock('./swarmSessions', () => ({
  readSwarmSessions: async (p: string) => ({ supply: { cwd: p, sessionId: 's1' } }),
}))
// One transcript per project when the test names them, else the shared one.
vi.mock('./transcript', () => ({ sessionJsonlPath: (cwd: string) => h.files[cwd] ?? h.file }))
vi.mock('./terminal', async (orig) => ({
  ...(await orig<typeof import('./terminal')>()),
  listLiveDesksIn: () => (h.desk ? [{ id: 'd1' }] : []),
}))

import { handlePhoneFrame, handleRelayFrame, phoneEventsFromLine, pumpTranscript, pairingCode, pairPhone, readPhoneLinkConfig, relayUrlAllowed, startPhoneLink, stopPhoneLink, unpairPhone, tick, __testLinkState } from './phoneLink'
import { alreadyStored, asCursor, type Cursor } from '../../../worker/src/phoneRelayAuth'
import { setLockdownCache } from './lockdown'
import { openGroundHome } from './paths'
import { phoneLinkRoutes } from '../../../server/routes/phoneLink'
import { resetSupplyNoticeState, SUPPLY_OWNER_SAY_MAX, SUPPLY_NOTICE_PREFIX, supplyNoticeLine, supplyReplyLine } from './supplyNotice'

const PROJECT = '/repo/alpha'
const CFG = { v: 1 as const, relayUrl: 'https://relay.test', macKey: 'm'.repeat(43), phoneKey: 'p'.repeat(43), projectId: 'p1' }

const fakeSocket = () => {
  const sent: Record<string, unknown>[] = []
  return { sent, sock: { readyState: 1, send: (s: string) => void sent.push(JSON.parse(s)) } }
}
// Like a real desk: a paste shows in the box, the Enter clears it.
const fakeDesk = () => {
  const writes: string[] = []
  let box = ''
  return {
    writes,
    deps: {
      desks: () => [{ id: 'd1', cwd: PROJECT }],
      screen: () =>
        ['⏺ done.', '', '─'.repeat(40), `❯ ${box}`, '─'.repeat(40), '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n'),
      write: (_id: string, data: string) => {
        if (data === '\r') box = ''
        else writes.push((box = data.replace(/\x1b\[20[01]~/g, '')))
        return true
      },
      sleep: async () => {},
    },
  }
}

const dir = mkdtempSync(join(tmpdir(), 'og-phone-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  resetSupplyNoticeState()
  h.owner = true
  h.desk = false
  h.projects = [{ id: 'p1', path: PROJECT }]
  h.files = {}
  setLockdownCache(false)
})

const line = (o: unknown) => JSON.stringify(o)
const user = (content: unknown, extra = {}) => line({ type: 'user', timestamp: '2026-10-01T00:00:00Z', message: { content }, ...extra })
const asst = (content: unknown) => line({ type: 'assistant', timestamp: '2026-10-01T00:00:01Z', message: { content } })

describe('phoneEventsFromLine — what the owner hears from a transcript line', () => {
  it('the owner words, the president text, an app notice and a commander reply', () => {
    expect(phoneEventsFromLine(user('進めて'))).toMatchObject([{ kind: 'owner', text: '進めて' }])
    expect(phoneEventsFromLine(asst([{ type: 'text', text: '承知しました' }, { type: 'tool_use', name: 'Bash' }]))).toMatchObject([
      { kind: 'president', text: '承知しました' },
    ])
    // Prefix and the instruction tail meant for the president are not read out.
    expect(phoneEventsFromLine(user(supplyNoticeLine('カードが1枚終わりました')))).toEqual([
      { kind: 'notice', text: 'カードが1枚終わりました', at: Date.parse('2026-10-01T00:00:00Z') },
    ])
    expect(phoneEventsFromLine(user(supplyReplyLine('入れて大丈夫です')))).toMatchObject([{ kind: 'commander', text: '入れて大丈夫です' }])
    // Typed while the president was mid-turn: a queued_command attachment.
    expect(phoneEventsFromLine(line({ type: 'attachment', attachment: { type: 'queued_command', prompt: '急いで' } }))).toMatchObject([
      { kind: 'owner', text: '急いで' },
    ])
  })
  it.each([
    ['a tool result', user([{ type: 'tool_result', content: 'ok' }])],
    ['a meta line', user('x', { isMeta: true })],
    ['a compaction summary', user('summary', { isCompactSummary: true })],
    ['a slash-command wrapper', user('<command-name>/supply</command-name>')],
    ['a task notification', user('done', { origin: { kind: 'task-notification' } })],
    ['an API error', line({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'err' }] } })],
    ['a torn line', '{"type":"user","mess'],
  ])('carries nothing for %s', (_l, l) => {
    expect(phoneEventsFromLine(l)).toEqual([])
  })
})

describe('handlePhoneFrame — the phone speaks', () => {
  it('a say lands in the president desk as the owner words and the phone hears queued then delivered', async () => {
    const { sent, sock } = fakeSocket()
    const desk = fakeDesk()
    const st = __testLinkState(CFG, sock)
    const woke: string[] = []
    await handlePhoneFrame(st, { type: 'say', id: 'c1', text: '今の状況は?' }, {
      supply: desk.deps,
      wakeDesk: async (p) => (woke.push(p), null),
    })
    expect(desk.writes).toEqual(['今の状況は?'])
    expect(sent.filter((f) => f.type === 'ack').map((f) => [f.id, f.state])).toEqual([
      ['c1', 'queued'],
      ['c1', 'delivered'],
    ])
    expect(woke).toEqual([PROJECT]) // no live desk in the pool ⇒ it was started first
  })

  it('the project picked because its president was up stays picked after that desk closes', async () => {
    const { sent, sock } = fakeSocket()
    const desk = fakeDesk()
    const { projectId: _drop, ...noPick } = CFG
    const st = __testLinkState(noPick, sock)
    h.desk = true
    await handlePhoneFrame(st, { type: 'projects' })
    expect(sent.at(-1)).toMatchObject({ type: 'projects', selected: 'p1' })
    h.desk = false // the owner closed the president at the Mac
    const woke: string[] = []
    await handlePhoneFrame(st, { type: 'say', id: 'k', text: '起きて' }, { supply: desk.deps, wakeDesk: async (p) => (woke.push(p), null) })
    expect(woke).toEqual([PROJECT])
    expect(desk.writes).toEqual(['起きて'])
  })

  it('without owner access nothing is typed and the phone is told no', async () => {
    h.owner = false
    const { sent, sock } = fakeSocket()
    const desk = fakeDesk()
    await handlePhoneFrame(__testLinkState(CFG, sock), { type: 'say', id: 'c2', text: 'x' }, { supply: desk.deps, wakeDesk: async () => null })
    expect(desk.writes).toEqual([])
    expect(sent).toMatchObject([{ type: 'ack', id: 'c2', state: 'rejected', reason: 'forbidden' }])
  })

  it('a say for an unknown project, or a desk that cannot start, is refused', async () => {
    const { sent, sock } = fakeSocket()
    const desk = fakeDesk()
    const st = __testLinkState(CFG, sock)
    await handlePhoneFrame(st, { type: 'say', id: 'a', text: 'x', projectId: 'nope' }, { supply: desk.deps })
    await handlePhoneFrame(st, { type: 'say', id: 'b', text: 'x' }, { supply: desk.deps, wakeDesk: async () => 'claude-unavailable' })
    expect(desk.writes).toEqual([])
    expect(sent.map((f) => [f.id, f.reason])).toEqual([
      ['a', 'no-project'],
      ['b', 'desk-failed'],
    ])
  })
  it('a say too long to type in safely is refused, never cut or split', async () => {
    const { sent, sock } = fakeSocket()
    const desk = fakeDesk()
    await handlePhoneFrame(__testLinkState(CFG, sock), { type: 'say', id: 'L', text: 'あ'.repeat(SUPPLY_OWNER_SAY_MAX + 1) }, {
      supply: desk.deps,
      wakeDesk: async () => null,
    })
    expect(desk.writes).toEqual([])
    expect(sent).toMatchObject([{ type: 'ack', id: 'L', state: 'rejected', reason: 'too-long' }])
  })

  it('a say that is empty once the mode characters are dropped is refused, not left queued forever', async () => {
    const { sent, sock } = fakeSocket()
    const desk = fakeDesk()
    const st = __testLinkState(CFG, sock)
    for (const text of ['/', '!!', ' # \\']) await handlePhoneFrame(st, { type: 'say', id: text, text }, { supply: desk.deps, wakeDesk: async () => null })
    expect(desk.writes).toEqual([])
    expect(sent.map((f) => [f.state, f.reason])).toEqual([
      ['rejected', 'empty'],
      ['rejected', 'empty'],
      ['rejected', 'empty'],
    ])
  })

  it('a say to another project selects it, so its answer is heard', async () => {
    h.projects = [{ id: 'p1', path: PROJECT }, { id: 'p2', path: '/repo/beta' }]
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG, sock)
    await handlePhoneFrame(st, { type: 'say', id: 's', text: 'こっち', projectId: 'p2' }, { supply: fakeDesk().deps, wakeDesk: async () => null })
    expect(sent.find((f) => f.type === 'projects')).toMatchObject({ selected: 'p2' })
  })
})

describe('pumpTranscript — the phone hears, in order, without replaying the past', () => {
  it('starts at the end, then sends each new event once; a dropped socket loses nothing', async () => {
    h.file = join(dir, 's1.jsonl')
    writeFileSync(h.file, user('昔の話') + '\n')
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG, sock)
    expect(await pumpTranscript(st)).toBe(0) // history is not replayed
    appendFileSync(h.file, user(`${SUPPLY_NOTICE_PREFIX}質問が1件`) + '\n' + asst([{ type: 'text', text: 'お知らせです' }]) + '\n')
    sock.readyState = 3 // closed: nothing may be marked as sent
    expect(await pumpTranscript(st)).toBe(0)
    sock.readyState = 1
    expect(await pumpTranscript(st)).toBe(2)
    expect(sent.map((f) => [f.type, f.kind, f.projectId])).toEqual([
      ['event', 'notice', 'p1'],
      ['event', 'president', 'p1'],
    ])
    appendFileSync(h.file, asst([{ type: 'text', text: '途中' }]).slice(0, 20)) // a half-written line waits
    expect(await pumpTranscript(st)).toBe(0)
  })
})

describe('pumpTranscript — a line too long to read in one go', () => {
  it('is stepped over instead of stalling the feed for good', async () => {
    h.file = join(dir, 's2.jsonl')
    writeFileSync(h.file, '')
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG, sock)
    await pumpTranscript(st)
    appendFileSync(h.file, user([{ type: 'image', data: 'x'.repeat(2 * 1024 * 1024) }]) + '\n' + asst([{ type: 'text', text: 'その後' }]) + '\n')
    for (let i = 0; i < 5; i++) await pumpTranscript(st)
    expect(sent.map((f) => f.text)).toEqual(['その後'])
  })

  it('a send that fails midway resends nothing already sent', async () => {
    h.file = join(dir, 's3.jsonl')
    writeFileSync(h.file, '')
    const sent: string[] = []
    const sock = { readyState: 1, send: (x: string) => void (sent.push(JSON.parse(x).text), sent.length === 1 && (sock.readyState = 3)) }
    const st = __testLinkState(CFG, sock)
    await pumpTranscript(st)
    appendFileSync(h.file, asst([{ type: 'text', text: '一' }]) + '\n' + asst([{ type: 'text', text: '二' }]) + '\n')
    await pumpTranscript(st)
    sock.readyState = 1
    await pumpTranscript(st)
    expect(sent).toEqual(['一', '二'])
  })
})

describe('a socket that stays OPEN but delivers nothing (Wi-Fi change, NAT drop, sleep)', () => {
  // The relay as it really behaves: stores an event unless its position was
  // already stored, and answers a new Mac connection with the newest position.
  const fakeRelay = () => {
    const stored: string[] = []
    let last: Cursor | null = null
    return {
      stored,
      resume: () => ({ type: 'resume', cur: last }),
      socket: (alive: () => boolean) => ({
        readyState: 1,
        send: (x: string) => {
          if (!alive()) return // into the void: the OS buffer took it, nothing arrives
          const f = JSON.parse(x)
          if (f.type !== 'event') return // acks / project lists are not stored
          const cur = asCursor(f.cur)
          if (cur && alreadyStored(last, cur)) return
          if (cur) last = cur
          stored.push(f.text)
        },
      }),
    }
  }

  it('after reconnecting, what went into the void is sent again — nothing missing, nothing twice', async () => {
    h.file = join(dir, 's4.jsonl')
    writeFileSync(h.file, '')
    const relay = fakeRelay()
    let alive = true
    const st = __testLinkState(CFG, relay.socket(() => alive))
    await handleRelayFrame(st, relay.resume())
    await pumpTranscript(st)
    appendFileSync(h.file, asst([{ type: 'text', text: '一' }, { type: 'text', text: '二' }]) + '\n')
    await pumpTranscript(st) // arrives
    alive = false
    appendFileSync(h.file, asst([{ type: 'text', text: '三' }]) + '\n' + user(`${SUPPLY_NOTICE_PREFIX}四`) + '\n')
    expect(await pumpTranscript(st)).toBe(2) // handed to an OPEN socket, lost on the way
    alive = true // the 90 s no-pong cut, then a new connection
    st.ws = relay.socket(() => alive) as unknown as typeof st.ws
    await handleRelayFrame(st, relay.resume())
    await pumpTranscript(st)
    expect(relay.stored).toEqual(['一', '二', '三', '四'])
  })

  it('away to another project and back, then a reconnect: what was said meanwhile stays unsaid', async () => {
    h.projects = [{ id: 'p1', path: PROJECT }, { id: 'p2', path: '/repo/beta' }]
    h.files = { [PROJECT]: join(dir, 'a.jsonl'), '/repo/beta': join(dir, 'b.jsonl') }
    writeFileSync(h.files[PROJECT], '')
    writeFileSync(h.files['/repo/beta'], '')
    const relay = fakeRelay()
    const st = __testLinkState(CFG, relay.socket(() => true))
    await handleRelayFrame(st, relay.resume())
    await pumpTranscript(st)
    appendFileSync(h.files[PROJECT], asst([{ type: 'text', text: 'A1' }]) + '\n')
    await pumpTranscript(st) // stored: the relay's position now points into A
    await handlePhoneFrame(st, { type: 'select', projectId: 'p2' })
    await pumpTranscript(st)
    appendFileSync(h.files[PROJECT], asst([{ type: 'text', text: 'said-in-A-while-away' }]) + '\n')
    await handlePhoneFrame(st, { type: 'select', projectId: 'p1' })
    await pumpTranscript(st)
    await handleRelayFrame(st, relay.resume()) // sleep / Wi-Fi change
    await pumpTranscript(st)
    expect(relay.stored).toEqual(['A1'])
  })

  it('right after the Mac restarts, what it sent into the void before is still recovered', async () => {
    h.file = join(dir, 's6.jsonl')
    writeFileSync(h.file, '')
    const relay = fakeRelay()
    let alive = true
    const before = __testLinkState(CFG, relay.socket(() => alive))
    await handleRelayFrame(before, relay.resume())
    await pumpTranscript(before)
    appendFileSync(h.file, asst([{ type: 'text', text: '届いた' }]) + '\n')
    await pumpTranscript(before)
    alive = false
    appendFileSync(h.file, asst([{ type: 'text', text: '消えた' }]) + '\n')
    await pumpTranscript(before) // then the app restarts: the new run reads its config from disk
    const after = __testLinkState((await readPhoneLinkConfig())!, relay.socket(() => true))
    await handleRelayFrame(after, relay.resume())
    await pumpTranscript(after)
    expect(relay.stored).toEqual(['届いた', '消えた'])
  })

  it('away to another project and back, then an app RESTART: what was said meanwhile stays unsaid', async () => {
    h.projects = [{ id: 'p1', path: PROJECT }, { id: 'p2', path: '/repo/beta' }]
    h.files = { [PROJECT]: join(dir, 'ra.jsonl'), '/repo/beta': join(dir, 'rb.jsonl') }
    writeFileSync(h.files[PROJECT], '')
    writeFileSync(h.files['/repo/beta'], '')
    const relay = fakeRelay()
    const st = __testLinkState(CFG, relay.socket(() => true))
    await handleRelayFrame(st, relay.resume())
    await pumpTranscript(st)
    appendFileSync(h.files[PROJECT], asst([{ type: 'text', text: 'A1' }]) + '\n')
    await pumpTranscript(st)
    await handlePhoneFrame(st, { type: 'select', projectId: 'p2' })
    await pumpTranscript(st)
    appendFileSync(h.files[PROJECT], asst([{ type: 'text', text: 'said-in-A-while-away' }]) + '\n')
    await handlePhoneFrame(st, { type: 'select', projectId: 'p1' })
    await pumpTranscript(st) // A is quiet from here on
    const after = __testLinkState((await readPhoneLinkConfig())!, relay.socket(() => true)) // quit, crash or auto-update
    await handleRelayFrame(after, relay.resume())
    await pumpTranscript(after)
    expect(relay.stored).toEqual(['A1'])
  })

  it('right after a restart, a project chosen before the first read is not reached back into', async () => {
    h.projects = [{ id: 'p1', path: PROJECT }, { id: 'p2', path: '/repo/beta' }]
    h.files = { [PROJECT]: join(dir, 'sa.jsonl'), '/repo/beta': join(dir, 'sb.jsonl') }
    writeFileSync(h.files[PROJECT], '')
    writeFileSync(h.files['/repo/beta'], '')
    const relay = fakeRelay()
    const st = __testLinkState({ ...CFG, projectId: 'p2' }, relay.socket(() => true))
    await handleRelayFrame(st, relay.resume())
    await pumpTranscript(st)
    appendFileSync(h.files['/repo/beta'], asst([{ type: 'text', text: 'B1' }]) + '\n')
    await pumpTranscript(st) // B is read from here (floor persisted) and B1 stored
    await handlePhoneFrame(st, { type: 'select', projectId: 'p1' })
    appendFileSync(h.files['/repo/beta'], asst([{ type: 'text', text: 'said-in-B-while-away' }]) + '\n')
    // Restart with the floor still naming B (p1 has not been read yet), then B is chosen at once.
    const after = __testLinkState({ ...(await readPhoneLinkConfig())!, projectId: 'p1', floor: st.cfg.floor }, relay.socket(() => true))
    await handlePhoneFrame(after, { type: 'select', projectId: 'p2' })
    await handleRelayFrame(after, relay.resume())
    await pumpTranscript(after)
    expect(relay.stored).toEqual(['B1'])
  })

  it('selecting the project already selected drops nothing', async () => {
    h.file = join(dir, 's7.jsonl')
    writeFileSync(h.file, '')
    const relay = fakeRelay()
    let alive = true
    const st = __testLinkState(CFG, relay.socket(() => alive))
    await handleRelayFrame(st, relay.resume())
    await pumpTranscript(st)
    alive = false
    appendFileSync(h.file, asst([{ type: 'text', text: '途中' }]) + '\n')
    await pumpTranscript(st) // into the void
    alive = true
    await handleRelayFrame(st, relay.resume()) // reconnected...
    await handlePhoneFrame(st, { type: 'select', projectId: 'p1' }) // ...and the phone re-selects the same project
    await pumpTranscript(st)
    expect(relay.stored).toEqual(['途中'])
  })

  it('what the president said under work mode never leaves the Mac, not even after it is switched off', async () => {
    h.file = join(dir, 's8.jsonl')
    writeFileSync(h.file, '')
    const relay = fakeRelay()
    const sock = Object.assign(relay.socket(() => true), { terminate: () => {} })
    const st = __testLinkState(CFG, sock)
    await handleRelayFrame(st, relay.resume())
    await pumpTranscript(st)
    appendFileSync(h.file, asst([{ type: 'text', text: '前' }]) + '\n')
    await pumpTranscript(st)
    setLockdownCache(true)
    st.lastHeard = Date.now()
    await tick(st) // the link is cut
    appendFileSync(h.file, asst([{ type: 'text', text: '業務モード中の話' }]) + '\n')
    setLockdownCache(false)
    await handleRelayFrame(st, relay.resume()) // reconnected
    await pumpTranscript(st)
    appendFileSync(h.file, asst([{ type: 'text', text: '後' }]) + '\n')
    await pumpTranscript(st)
    expect(relay.stored).toEqual(['前', '後'])
  })

  it('work-mode talk is not read out as new after an app RESTART either (cut while linked)', async () => {
    h.file = join(dir, 's9.jsonl')
    writeFileSync(h.file, '')
    const relay = fakeRelay()
    const st = __testLinkState(CFG, Object.assign(relay.socket(() => true), { terminate: () => {} }))
    await handleRelayFrame(st, relay.resume())
    await pumpTranscript(st)
    appendFileSync(h.file, asst([{ type: 'text', text: '前' }]) + '\n')
    await pumpTranscript(st)
    setLockdownCache(true)
    st.lastHeard = Date.now()
    await tick(st) // the link is cut
    appendFileSync(h.file, asst([{ type: 'text', text: '業務モード中の話' }]) + '\n')
    setLockdownCache(false)
    const after = __testLinkState((await readPhoneLinkConfig())!, relay.socket(() => true)) // restart
    await handleRelayFrame(after, relay.resume())
    await pumpTranscript(after)
    appendFileSync(h.file, asst([{ type: 'text', text: '後' }]) + '\n')
    await pumpTranscript(after)
    expect(relay.stored).toEqual(['前', '後'])
  })

  it('work-mode talk is not read out after a restart that BOOTED under work mode', async () => {
    h.file = join(dir, 's10.jsonl')
    writeFileSync(h.file, '')
    const relay = fakeRelay()
    const before = __testLinkState(CFG, relay.socket(() => true))
    await handleRelayFrame(before, relay.resume())
    await pumpTranscript(before)
    appendFileSync(h.file, asst([{ type: 'text', text: '前' }]) + '\n')
    await pumpTranscript(before) // quit with the floor on disk
    setLockdownCache(true)
    process.env.OPENGROUND_PHONE_LINK = '1'
    try {
      expect(await startPhoneLink()).toBe(true) // boots, waits under work mode
      // Let its (unawaited) save land; what counts is what the phone hears below.
      await vi.waitFor(async () => expect((await readPhoneLinkConfig())?.floor).toBeUndefined()).catch(() => {})
    } finally {
      stopPhoneLink()
      delete process.env.OPENGROUND_PHONE_LINK
    }
    appendFileSync(h.file, asst([{ type: 'text', text: '業務モード中の話' }]) + '\n')
    setLockdownCache(false)
    const after = __testLinkState((await readPhoneLinkConfig())!, relay.socket(() => true)) // restart, work mode off
    await handleRelayFrame(after, relay.resume())
    await pumpTranscript(after)
    appendFileSync(h.file, asst([{ type: 'text', text: '後' }]) + '\n')
    await pumpTranscript(after)
    expect(relay.stored).toEqual(['前', '後'])
  })

  it('a project left, then unregistered, is not reached back into after a restart', async () => {
    h.projects = [{ id: 'p1', path: PROJECT }, { id: 'p2', path: '/repo/beta' }]
    h.files = { [PROJECT]: join(dir, 'ua.jsonl'), '/repo/beta': join(dir, 'ub.jsonl') }
    writeFileSync(h.files[PROJECT], '')
    const relay = fakeRelay()
    const st = __testLinkState(CFG, relay.socket(() => true))
    await handleRelayFrame(st, relay.resume())
    await pumpTranscript(st)
    appendFileSync(h.files[PROJECT], asst([{ type: 'text', text: 'A1' }]) + '\n')
    await pumpTranscript(st)
    await handlePhoneFrame(st, { type: 'select', projectId: 'p2' }) // p2 has no transcript: no new floor
    appendFileSync(h.files[PROJECT], asst([{ type: 'text', text: 'said-in-A-while-away' }]) + '\n')
    h.projects = [{ id: 'p1', path: PROJECT }] // p2 unregistered, then a restart falls back to p1
    h.desk = true
    const after = __testLinkState((await readPhoneLinkConfig())!, relay.socket(() => true))
    await handleRelayFrame(after, relay.resume())
    await pumpTranscript(after)
    expect(relay.stored).toEqual(['A1'])
  })

  it('a resume left pending by a project with no transcript is not applied to the next one', async () => {
    // Two defences close this path (the pending resume is dropped on a switch,
    // and a switched-to tail is never rewound before its start) — this test
    // goes red only when BOTH are gone (measured 2026-10-01).
    h.projects = [{ id: 'p1', path: PROJECT }, { id: 'p2', path: '/repo/beta' }]
    h.files = { [PROJECT]: join(dir, 'none.jsonl'), '/repo/beta': join(dir, 'b2.jsonl') }
    writeFileSync(h.files['/repo/beta'], '')
    const relay = fakeRelay()
    const st = __testLinkState({ ...CFG, projectId: 'p2' }, relay.socket(() => true))
    await handleRelayFrame(st, relay.resume())
    await pumpTranscript(st)
    appendFileSync(h.files['/repo/beta'], asst([{ type: 'text', text: 'B1' }]) + '\n')
    await pumpTranscript(st) // the relay's position now points into B
    await handlePhoneFrame(st, { type: 'select', projectId: 'p1' }) // p1 has no transcript yet
    appendFileSync(h.files['/repo/beta'], asst([{ type: 'text', text: 'said-in-B-while-away' }]) + '\n')
    await handleRelayFrame(st, relay.resume()) // reconnect: stays pending, p1 has nothing to apply it to
    await pumpTranscript(st)
    await handlePhoneFrame(st, { type: 'select', projectId: 'p2' })
    await pumpTranscript(st)
    expect(relay.stored).toEqual(['B1'])
  })

  it('also when the relay had stored nothing of this transcript yet', async () => {
    h.file = join(dir, 's5.jsonl')
    writeFileSync(h.file, user('昔') + '\n')
    const relay = fakeRelay()
    let alive = false
    const st = __testLinkState(CFG, relay.socket(() => alive))
    await pumpTranscript(st)
    appendFileSync(h.file, asst([{ type: 'text', text: '返事' }]) + '\n')
    await pumpTranscript(st)
    alive = true
    await handleRelayFrame(st, relay.resume())
    await pumpTranscript(st)
    expect(relay.stored).toEqual(['返事']) // and not the history before the link began
  })
})

describe('work mode and the pairing key', () => {
  it('a relay URL that would carry the keys unencrypted is refused', async () => {
    expect(relayUrlAllowed('https://og-phone-relay.example.workers.dev')).toBe(true)
    expect(relayUrlAllowed('http://127.0.0.1:8787')).toBe(true)
    expect(relayUrlAllowed('http://relay.example.com')).toBe(false)
    process.env.OPENGROUND_PHONE_RELAY_URL = 'http://relay.example.com'
    try {
      expect(await pairPhone()).toEqual({ error: 'insecure-relay' })
    } finally {
      delete process.env.OPENGROUND_PHONE_RELAY_URL
    }
  })

  it('a link that was stopped never writes its (old) keys back', async () => {
    const { projectId: _drop, ...noPick } = CFG
    const st = __testLinkState(noPick, fakeSocket().sock)
    st.retired = true
    rmSync(join(openGroundHome(), 'phone-link.json'), { force: true }) // earlier tests saved one
    h.desk = true
    await handlePhoneFrame(st, { type: 'projects' }) // would pick p1 and save it
    await handlePhoneFrame(st, { type: 'select', projectId: 'p1' })
    expect(await readPhoneLinkConfig()).toBeNull()
  })

  it('work mode switched on while linked closes the open socket', async () => {
    let closed = false
    const st = __testLinkState(CFG, { readyState: 1, send: () => {} })
    ;(st.ws as unknown as { terminate: () => void }).terminate = () => void (closed = true)
    st.lastHeard = Date.now()
    setLockdownCache(true)
    await tick(st)
    expect(closed).toBe(true)
  })

  it('in the moment before work mode cuts the link, the phone is told nothing', async () => {
    h.desk = true
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG, sock)
    setLockdownCache(true)
    await handlePhoneFrame(st, { type: 'projects' })
    await handlePhoneFrame(st, { type: 'select', projectId: 'p1' })
    expect(sent).toEqual([])
  })

  it('a quiet link pings once per 30 s, not on every tick', async () => {
    const pings: string[] = []
    const st = __testLinkState(CFG, { readyState: 1, send: (x: string) => void (x === 'ping' && pings.push(x)) })
    st.lastHeard = Date.now() - 40_000
    for (let i = 0; i < 5; i++) await tick(st)
    expect(pings).toHaveLength(1)
  })

  it('pairing and unpairing are refused under work mode (no dial out)', async () => {
    setLockdownCache(true)
    expect(await pairPhone()).toEqual({ error: 'lockdown' })
    expect(await unpairPhone()).toEqual({ error: 'lockdown' })
  })

  it('the pairing code is not handed to a page that reached this Mac under another host name', async () => {
    const r = await phoneLinkRoutes.request('/api/phone-link/code', { method: 'POST', headers: { host: 'evil.example:47776' } })
    expect(r.status).toBe(403)
    const g = await phoneLinkRoutes.request('/api/phone-link', { headers: { host: 'evil.example:47776' } })
    expect(g.status).toBe(403)
    expect((await phoneLinkRoutes.request('/api/phone-link/code', { headers: { host: '127.0.0.1:47776' } })).status).toBe(404)
  })
})

describe('pairingCode', () => {
  it('carries the phone URL of the room named by the phone key hash, and the phone key', () => {
    const c = JSON.parse(Buffer.from(pairingCode(CFG), 'base64url').toString())
    expect(c.v).toBe(1)
    expect(c.key).toBe(CFG.phoneKey)
    expect(c.url).toMatch(/^wss:\/\/relay\.test\/v1\/[0-9a-f]{64}\/phone$/)
    expect(c.url).not.toContain(CFG.macKey)
  })
})

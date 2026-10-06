// Phone link, Mac end (phoneLink.ts). Asserts what reaches the DESK and what
// reaches the PHONE (the frames sent), never "a function was called".
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({ owner: true, desk: false, file: '', files: {} as Record<string, string>, projects: [] as { id: string; path: string }[], language: undefined as string | undefined, settingsThrow: false }))
vi.mock('./swarmGate', () => ({ isSwarmLocalOwnerUnlocked: async () => h.owner }))
vi.mock('./roles', () => ({ getCustomTabRole: async () => null }))
vi.mock('./store', async (orig) => ({
  ...(await orig<typeof import('./store')>()),
  getSettings: async () => {
    if (h.settingsThrow) throw new Error('settings unreadable')
    return { projects: h.projects, language: h.language }
  },
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

import { AssistantFailure, askAssistant, __resetAssistantMemory } from './phoneAssistant'
import { __resetProposals, openProposals, proposalHash, proposeMessage } from './assistantProposals'
// A message any path sends to a commander lands here (never a real desk).
const relayed = vi.hoisted(() => [] as string[])
vi.mock('./commanderRelay', () => ({ relayToCommander: async (_path: string, text: string) => (relayed.push(text), { ok: true, delivered: true, runtime: 'sdk', woke: false }) }))
import { __testConnect, flushAssistantOutbox, flushPush, PUSH_GAP_MS, PUSH_RETRY_MAX, SAY_HOLD_MAX_MS, handlePhoneFrame, handleRelayFrame, phoneEventsFromLine, pumpTranscript, pairingCode, pairPhone, readPhoneLinkConfig, relayUrlAllowed, startPhoneLink, stopPhoneLink, unpairPhone, tick, __testLinkState } from './phoneLink'
import { alreadyStored, asCursor, type Cursor, type PushTarget } from '../../../worker/src/phoneRelayAuth'
import { setLockdownCache } from './lockdown'
import { saveAssistantConfig } from './assistantMemory'
import { openGroundHome } from './paths'
import { phoneLinkRoutes } from '../../../server/routes/phoneLink'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { e2eKeyOf, open as openSealed } from './phoneLinkSeal'
import { statSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { JWT_MIN_AGE_MS, savePushKey, type PushKey } from './phonePush'
import { flushSupplyNotices, resetSupplyNoticeState, SUPPLY_OWNER_SAY_MAX, SUPPLY_NOTICE_PREFIX, supplyNoticeLine, supplyReplyLine } from './supplyNotice'

const PROJECT = '/repo/alpha'
const CFG = { v: 1 as const, relayUrl: 'https://relay.test', macKey: 'm'.repeat(43), phoneKey: 'p'.repeat(43), projectId: 'p1' }
/** A sealed (v2) pairing — the only kind the assistant talks to. */
const E2E = randomBytes(32).toString('base64url')
const CFG2 = { ...CFG, v: 2 as const, e2eKey: E2E }

/** What went out, a sealed frame read as the phone opens it (its sealing has its own tests). */
const fakeSocket = () => {
  const sent: Record<string, unknown>[] = []
  const read = (f: Record<string, unknown>) => (typeof f.box === 'string' ? { ...f, ...(openSealed(e2eKeyOf(E2E)!, 'm2p', f.box) as Record<string, unknown>) } : f)
  return { sent, sock: { readyState: 1, send: (s: string) => void sent.push(read(JSON.parse(s))) } }
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
  h.language = undefined
  h.settingsThrow = false
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

describe('the phone opening the assistant warms its session', () => {
  it('an assistant-history fetch starts the session ahead of the first line (the live link passes warm)', async () => {
    const { sock } = fakeSocket()
    const st = __testLinkState(CFG2, sock)
    let warmed = 0
    await handlePhoneFrame(st, { type: 'assistant-history', id: 'h1' }, { warm: async () => void warmed++ })
    expect(warmed).toBe(1)
    // Its older pages, and a project's call history, start nothing more.
    await handlePhoneFrame(st, { type: 'assistant-history', id: 'h2', before: Date.now() }, { warm: async () => void warmed++ })
    expect(warmed).toBe(1)
  })

  it('an old plaintext (v1) pairing never reaches the assistant: no say is asked, no history starts it', async () => {
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG, sock)
    let warmed = 0
    const asked: string[] = []
    await handlePhoneFrame(st, { type: 'assistant-history', id: 'h1' }, { warm: async () => void warmed++ })
    await handlePhoneFrame(st, { type: 'say', id: 'v1', text: 'うん', projectId: 'assistant' }, { assistant: async (t) => (asked.push(t), { reply: 'x' }) })
    expect(warmed).toBe(0)
    expect(asked).toEqual([])
    expect(sent.filter((f) => f.type === 'ack').map((f) => [f.id, f.state, f.reason])).toEqual([['v1', 'rejected', 'pair-again']])
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

describe('the assistant — a talk partner of its own, heard on the phone only', () => {
  it('heads the project list and is never the selected project', async () => {
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG, sock)
    await handlePhoneFrame(st, { type: 'select', projectId: 'assistant' })
    const f = sent.at(-1) as { type: string; selected: string; projects: { id: string }[] }
    expect(f.type).toBe('projects')
    expect(f.projects.map((p) => p.id)).toEqual(['assistant', 'p1'])
    expect(f.selected).toBe('p1')
  })

  it('carries the name and colour the owner gave it, and a plain name before that', async () => {
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG, sock)
    const entry = () => (sent.at(-1) as { projects: { id: string; name: string; look?: string }[] }).projects[0]
    try {
      await handlePhoneFrame(st, { type: 'projects' })
      expect(entry().name).not.toBe('')
      expect(entry().look).toBe('verm')
      await saveAssistantConfig({ name: 'ノノ', look: 'moss' })
      await handlePhoneFrame(st, { type: 'projects' })
      expect(entry()).toMatchObject({ id: 'assistant', name: 'ノノ', look: 'moss' })
    } finally {
      await saveAssistantConfig({ name: '', look: 'verm' })
    }
  })

  it('a say to it is answered to the phone and never typed into a president desk', async () => {
    const { sent, sock } = fakeSocket()
    const desk = fakeDesk()
    const st = __testLinkState(CFG2, sock)
    const asked: string[] = []
    await handlePhoneFrame(st, { type: 'say', id: 'a1', text: 'alphaでログイン直して', projectId: 'assistant' }, {
      supply: desk.deps,
      wakeDesk: async () => 'must not wake a desk',
      assistant: async (t) => (asked.push(t), { reply: 'alphaにカード案を出したよ。' }),
    })
    expect(asked).toEqual(['alphaでログイン直して'])
    expect(desk.writes).toEqual([])
    expect(sent.filter((f) => f.type === 'ack').map((f) => [f.id, f.state, f.projectId])).toEqual([
      ['a1', 'queued', 'assistant'],
      ['a1', 'delivered', 'assistant'],
    ])
    expect(sent.filter((f) => f.type === 'event').map((f) => [f.projectId, f.kind, f.text])).toEqual([
      ['assistant', 'owner', 'alphaでログイン直して'],
      ['assistant', 'assistant', 'alphaにカード案を出したよ。'],
    ])
    expect(st.says.size).toBe(0) // the push hold is released once the answer is out
    // The phone matches the echo to its say by id, not by the words.
    expect(sent.find((f) => f.type === 'event' && f.kind === 'owner')?.id).toBe('a1')
  })

  it('the phone sees its own proposals and presses them through the same one door: a say never carries one out', async () => {
    __resetProposals()
    relayed.length = 0
    const ctx = (via: 'phone' | 'screen') => ({ lang: 'en' as const, now: Date.now(), via, projects: async () => [{ id: 'p1', name: 'alpha', path: PROJECT }] })
    const mine = await proposeMessage('p1', 'tests first', ctx('phone'))
    await proposeMessage('p1', 'from the Mac', ctx('screen'))
    if (typeof mine === 'string') throw new Error(mine)
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG2, sock)
    // Its frames come with the first page of the records — the phone's only.
    await handlePhoneFrame(st, { type: 'assistant-history', id: 'h1' })
    const page = sent.find((f) => f.type === 'assistant-history') as { proposals?: { id: string }[] } | undefined
    expect(page?.proposals?.map((x) => x.id)).toEqual([mine.id])
    // A yes said on the phone is only a line to the assistant.
    await handlePhoneFrame(st, { type: 'say', id: 's1', text: 'うん、送って', projectId: 'assistant' }, { assistant: async () => ({ reply: '画面のボタンで決めてね' }) })
    expect(relayed).toEqual([])
    // A button press with a check of another text, or from an old pairing: nothing.
    sent.length = 0
    await handlePhoneFrame(st, { type: 'assistant-proposal', id: 'b1', proposalId: mine.id, action: 'approve', hash: proposalHash({ ...mine, body: mine.body + '!' }) })
    expect(sent.find((f) => f.id === 'b1')).toMatchObject({ type: 'ack', state: 'rejected', reason: 'mismatch' })
    await handlePhoneFrame(__testLinkState(CFG, fakeSocket().sock), { type: 'assistant-proposal', id: 'b2', proposalId: mine.id, action: 'approve', hash: proposalHash(mine) })
    expect(relayed).toEqual([])
    // The press with the shown text's check: the line the frame showed is sent, and the phone hears the app's line.
    await handlePhoneFrame(st, { type: 'assistant-proposal', id: 'b3', proposalId: mine.id, action: 'approve', hash: proposalHash(mine) })
    expect(relayed).toEqual([mine.body])
    expect(sent.find((f) => f.id === 'b3')).toMatchObject({ type: 'ack', state: 'delivered' })
    expect(sent.find((f) => f.kind === 'assistant')).toMatchObject({ text: "Passed to alpha's commander.", speak: "Passed to alpha's commander." })
    // Pressed twice (the Mac's window first, say): once only.
    await handlePhoneFrame(st, { type: 'assistant-proposal', id: 'b4', proposalId: mine.id, action: 'approve', hash: proposalHash(mine) })
    expect(sent.find((f) => f.id === 'b4')).toMatchObject({ state: 'rejected', reason: 'closed' })
    expect(relayed).toHaveLength(1)
    // 「やめる」 from the phone.
    const other = openProposals()[0]
    await handlePhoneFrame(st, { type: 'assistant-proposal', id: 'b5', proposalId: other.id, action: 'drop' })
    expect(sent.find((f) => f.id === 'b5')).toMatchObject({ state: 'delivered' })
    expect(openProposals()).toEqual([])
  })

  it('an answer that finds the relay socket closed is sent once it is back, in order', async () => {
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG2, sock)
    sock.readyState = 3 // closed while the assistant was thinking
    await handlePhoneFrame(st, { type: 'say', id: 'o1', text: '全体どう?', projectId: 'assistant' }, {
      assistant: async () => ({ reply: '全部順調' }),
    })
    expect(sent).toEqual([])
    sock.readyState = 1
    st.lastHeard = Date.now()
    await tick(st)
    const mine = sent.filter((f) => f.projectId === 'assistant' || f.id === 'o1')
    expect(mine.map((f) => [f.type, f.state ?? f.kind])).toEqual([
      ['ack', 'queued'],
      ['event', 'owner'],
      ['ack', 'delivered'],
      ['event', 'assistant'],
    ])
    await tick(st)
    expect(sent.filter((f) => f.kind === 'assistant')).toHaveLength(1) // sent once, not again
  })

  it('kept answers go out before a newer line, so the phone never hears them out of order', async () => {
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG2, sock)
    sock.readyState = 3
    await handlePhoneFrame(st, { type: 'say', id: 'old', text: '一つ目', projectId: 'assistant' }, { assistant: async () => ({ reply: '古い答え' }) })
    sock.readyState = 1 // back, before any tick
    await handlePhoneFrame(st, { type: 'say', id: 'new', text: '二つ目', projectId: 'assistant' }, { assistant: async () => ({ reply: '新しい答え' }) })
    expect(sent.filter((f) => f.kind === 'assistant').map((f) => f.text)).toEqual(['古い答え', '新しい答え'])
    expect(sent.filter((f) => f.type === 'ack').map((f) => f.id)).toEqual(['old', 'old', 'new', 'new'])
  })

  it('at most 20 kept frames: the oldest go first', async () => {
    const { sock } = fakeSocket()
    const st = __testLinkState(CFG2, sock)
    sock.readyState = 3
    for (let i = 1; i <= 6; i++)
      await handlePhoneFrame(st, { type: 'say', id: `k${i}`, text: `${i}`, projectId: 'assistant' }, { assistant: async () => ({ reply: `r${i}` }) })
    expect(st.assistantOutbox).toHaveLength(20)
    expect(st.assistantOutbox.at(-1)).toMatchObject({ kind: 'assistant', text: 'r6' })
  })

  it('work mode drops what was kept: it is never sent, not even once switched off', async () => {
    const sent: Record<string, unknown>[] = []
    const sock = { readyState: 3, send: (s: string) => void sent.push(JSON.parse(s)), terminate: () => {} }
    const st = __testLinkState(CFG2, sock)
    await handlePhoneFrame(st, { type: 'say', id: 'z1', text: '全体どう?', projectId: 'assistant' }, { assistant: async () => ({ reply: '秘密の答え' }) })
    sock.readyState = 1
    setLockdownCache(true)
    await tick(st) // work mode cuts the link
    setLockdownCache(false)
    st.lastHeard = Date.now()
    await tick(st)
    expect(sent.filter((f) => f.projectId === 'assistant' || f.id === 'z1')).toEqual([])
  })

  it('work mode met on the reconnect drops what was kept: nothing is sent after it is switched off', async () => {
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG2, sock)
    sock.readyState = 3 // socket down: frames are kept, tick does nothing
    await handlePhoneFrame(st, { type: 'say', id: 'c1', text: '全体どう?', projectId: 'assistant' }, { assistant: async () => ({ reply: '秘密の答え' }) })
    expect(st.assistantOutbox.length).toBeGreaterThan(0)
    st.stopped = false
    setLockdownCache(true)
    __testConnect(st) // the path a closed socket actually takes
    st.stopped = true
    clearTimeout(st.retry)
    setLockdownCache(false)
    sock.readyState = 1 // reconnected after work mode
    st.lastHeard = Date.now()
    await tick(st)
    expect(sent.filter((f) => f.projectId === 'assistant' || f.id === 'c1')).toEqual([])
  })

  it("a failure is told in the Mac's language, and still told when the settings cannot be read", async () => {
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG2, sock)
    const timedOut = async () => {
      throw new Error('canvas AI session timed out')
    }
    h.language = 'ja'
    await handlePhoneFrame(st, { type: 'say', id: 'j1', text: '全体どう?', projectId: 'assistant' }, { assistant: timedOut })
    h.settingsThrow = true
    await handlePhoneFrame(st, { type: 'say', id: 'j2', text: '全体どう?', projectId: 'assistant' }, { assistant: timedOut })
    expect(sent.filter((f) => f.state === 'rejected').map((f) => [f.id, f.detail])).toEqual([
      ['j1', 'アシスタントが時間内に答えられませんでした。'],
      ['j2', 'The assistant did not answer in time.'],
    ])
  })

  it('a full assistant gets just busy: nothing queued, nothing echoed, not asked', async () => {
    __resetAssistantMemory()
    const never: Parameters<typeof askAssistant>[1] = { run: () => new Promise(() => {}), digest: async () => ({ text: '', projects: [] }) }
    void askAssistant('1', never).catch(() => {})
    void askAssistant('2', never).catch(() => {})
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG2, sock)
    const asked: string[] = []
    await handlePhoneFrame(st, { type: 'say', id: 'f3', text: '3', projectId: 'assistant' }, {
      assistant: async (t) => (asked.push(t), { reply: 'x' }),
    })
    __resetAssistantMemory()
    expect(asked).toEqual([])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'ack', id: 'f3', state: 'rejected', reason: 'busy' })
  })

  it('a busy assistant and an internal failure reach the phone as a reason and plain words only', async () => {
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG2, sock)
    await handlePhoneFrame(st, { type: 'say', id: 'b1', text: 'まだ?', projectId: 'assistant' }, {
      assistant: async () => {
        throw new AssistantFailure('busy', 'still answering')
      },
    })
    await handlePhoneFrame(st, { type: 'say', id: 'b2', text: '全体どう?', projectId: 'assistant' }, {
      assistant: async () => {
        throw new Error('projectUUIDFromPath: no registered project owns /Users/x/secret')
      },
    })
    const final = sent.filter((f) => f.type === 'ack' && f.state === 'rejected')
    expect(final.map((f) => [f.id, f.reason])).toEqual([
      ['b1', 'busy'],
      ['b2', 'assistant-failed'],
    ])
    expect(JSON.stringify(final)).not.toMatch(/projectUUIDFromPath|\/Users\//)
  })

  it('an assistant that cannot answer is reported, not left queued', async () => {
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG2, sock)
    await handlePhoneFrame(st, { type: 'say', id: 'a2', text: '全体どう?', projectId: 'assistant' }, {
      assistant: async () => {
        throw new Error('claude not ready')
      },
    })
    expect(sent.filter((f) => f.type === 'ack').map((f) => [f.state, f.reason])).toEqual([
      ['queued', undefined],
      ['rejected', 'assistant-failed'],
    ])
    expect(st.says.size).toBe(0)
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

describe('the owner echo carries the id of the phone say it came from', () => {
  it('a phone say echoes with its id; words typed at the Mac have none; a resend keeps the id', async () => {
    h.file = join(dir, 'say-id.jsonl')
    writeFileSync(h.file, '')
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG, sock)
    await pumpTranscript(st)
    // Same words twice from the phone: each echo gets its own say, in order.
    for (const id of ['s1', 's2']) await handlePhoneFrame(st, { type: 'say', id, text: '/ 進めて ' }, { supply: fakeDesk().deps, wakeDesk: async () => null })
    appendFileSync(h.file, [user('進めて'), user('Macで打った'), user('進めて')].join('\n') + '\n')
    sock.readyState = 3 // the first try goes nowhere: the resend must carry the same ids
    expect(await pumpTranscript(st)).toBe(0)
    sock.readyState = 1
    expect(await pumpTranscript(st)).toBe(3)
    expect(sent.filter((f) => f.type === 'event').map((f) => [f.kind, f.text, f.id])).toEqual([
      ['owner', '進めて', 's1'],
      ['owner', 'Macで打った', undefined],
      ['owner', '進めて', 's2'],
    ])
  })

  it('claude drops lone invisible characters from the transcript: the echo still gets the id', async () => {
    h.file = join(dir, 'say-id-invisible.jsonl')
    writeFileSync(h.file, '')
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG, sock)
    await pumpTranscript(st)
    for (const [id, text] of [['zw', '進め\u200bて'], ['ivs', '葛\u{E0100}']]) await handlePhoneFrame(st, { type: 'say', id, text }, { supply: fakeDesk().deps, wakeDesk: async () => null })
    appendFileSync(h.file, [user('進めて'), user('葛')].join('\n') + '\n')
    await pumpTranscript(st)
    expect(sent.filter((f) => f.kind === 'owner').map((f) => f.id)).toEqual(['zw', 'ivs'])
  })

  it('emoji VS16 / ZWJ stay in the transcript: the echo still gets the id', async () => {
    h.file = join(dir, 'say-id-emoji.jsonl')
    writeFileSync(h.file, '')
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG, sock)
    await pumpTranscript(st)
    const words = ['了解\u2764\uFE0F', '家族\u{1F468}\u200D\u{1F469}\u200D\u{1F467}']
    for (let i = 0; i < words.length; i++) await handlePhoneFrame(st, { type: 'say', id: `e${i}`, text: words[i] }, { supply: fakeDesk().deps, wakeDesk: async () => null })
    appendFileSync(h.file, words.map((w) => user(w)).join('\n') + '\n')
    await pumpTranscript(st)
    expect(sent.filter((f) => f.kind === 'owner').map((f) => f.id)).toEqual(['e0', 'e1'])
  })

  it('a say not echoed before work mode went on never lends its id to a later one', async () => {
    h.file = join(dir, 'say-id-lockdown.jsonl')
    writeFileSync(h.file, '')
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG, Object.assign(sock, { terminate: () => {} }))
    st.lastHeard = Date.now()
    await pumpTranscript(st)
    await handlePhoneFrame(st, { type: 'say', id: 'old', text: 'はい' }, { supply: fakeDesk().deps, wakeDesk: async () => null })
    setLockdownCache(true)
    await tick(st) // work mode: the link is cut and the tail forgotten
    setLockdownCache(false)
    sock.readyState = 1
    await pumpTranscript(st)
    await handlePhoneFrame(st, { type: 'say', id: 'new', text: 'はい' }, { supply: fakeDesk().deps, wakeDesk: async () => null })
    appendFileSync(h.file, user('はい') + '\n')
    await pumpTranscript(st)
    expect(sent.filter((f) => f.kind === 'owner').map((f) => f.id)).toEqual(['new'])
  })

  it('a say the owner cleared from the box never lends its id to a later one with the same words', async () => {
    h.file = join(dir, 'say-id-lost.jsonl')
    writeFileSync(h.file, '')
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG, sock)
    let box = ''
    let swallow = true // the Enter does not take, until the owner clears the box by hand
    const desk = {
      ...fakeDesk().deps,
      screen: () => ['⏺ done.', '', '─'.repeat(40), `❯ ${box}`, '─'.repeat(40), '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n'),
      write: (_id: string, data: string) => {
        if (data !== '\r') box = data.replace(/\x1b\[20[01]~/g, '')
        else if (!swallow) box = ''
        return true
      },
    }
    await pumpTranscript(st)
    await handlePhoneFrame(st, { type: 'say', id: 'lost', text: 'はい' }, { supply: desk, wakeDesk: async () => null })
    box = ''
    swallow = false
    await handlePhoneFrame(st, { type: 'say', id: 's2', text: 'はい' }, { supply: desk, wakeDesk: async () => null })
    await flushSupplyNotices(desk)
    appendFileSync(h.file, user('はい') + '\n')
    await pumpTranscript(st)
    expect(sent.filter((f) => f.state === 'delivered').map((f) => [f.id, f.heard])).toEqual([
      ['lost', false],
      ['s2', true],
    ])
    expect(sent.filter((f) => f.kind === 'owner').map((f) => f.id)).toEqual(['s2'])
  })

  it('switching projects drops the says to the one left that were not echoed yet', async () => {
    h.projects = [
      { id: 'p1', path: PROJECT },
      { id: 'p2', path: '/repo/beta' },
    ]
    h.files = { [PROJECT]: join(dir, 'sw-a.jsonl'), '/repo/beta': join(dir, 'sw-b.jsonl') }
    for (const f of Object.values(h.files)) writeFileSync(f, '')
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG, sock)
    await pumpTranscript(st)
    await handlePhoneFrame(st, { type: 'say', id: 'never', text: 'はい' }, { supply: fakeDesk().deps, wakeDesk: async () => null }) // typed, not transcribed
    await handlePhoneFrame(st, { type: 'select', projectId: 'p2' })
    await handlePhoneFrame(st, { type: 'select', projectId: 'p1' })
    await pumpTranscript(st)
    appendFileSync(h.files[PROJECT], user('はい') + '\n') // typed at the Mac
    await pumpTranscript(st)
    expect(sent.filter((f) => f.kind === 'owner').map((f) => [f.projectId, f.id])).toEqual([['p1', undefined]])
  })

  it("another project's say never lends its id to this project's echo", async () => {
    h.projects = [
      { id: 'p1', path: PROJECT },
      { id: 'p2', path: '/repo/beta' },
    ]
    h.files = { [PROJECT]: join(dir, 'pj-a.jsonl'), '/repo/beta': join(dir, 'pj-b.jsonl') }
    for (const f of Object.values(h.files)) writeFileSync(f, '')
    h.desk = true
    const { sent, sock } = fakeSocket()
    const st = __testLinkState(CFG, sock)
    await handlePhoneFrame(st, { type: 'say', id: 'beta', text: 'はい', projectId: 'p2' }, { supply: fakeDesk().deps, wakeDesk: async () => null })
    h.projects = [{ id: 'p1', path: PROJECT }] // p2 unregistered: the link falls back to p1 without a select
    await pumpTranscript(st)
    appendFileSync(h.files[PROJECT], user('はい') + '\n') // typed at the Mac
    await pumpTranscript(st)
    expect(sent.filter((f) => f.kind === 'owner').map((f) => [f.projectId, f.id])).toEqual([['p1', undefined]])
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

// ── waking the phone (Push to Talk, docs/PHONE_LINK.md "Waking the phone") ──

describe('waking the phone with a Push to Talk push', () => {
  const P8 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const KEY: PushKey = { v: 1, keyId: 'ABC123DEFG', teamId: 'TEAM123456', p8: P8 }
  const T1: PushTarget = { token: 'ab'.repeat(32), env: 'production', topic: 'com.nannantown.openground.phone.voip-ptt' }
  const T2: PushTarget = { ...T1, token: 'cd'.repeat(32), env: 'development' }
  const cfgFile = () => join(openGroundHome(), 'phone-link.json')

  /** A link with a token and a recording APNs: `pushes` = the targets pushed to. */
  const pushing = (reply: { status: number; reason?: string } = { status: 200 }) => {
    const pushes: (typeof T1)[] = []
    const { sent, sock } = fakeSocket()
    const st = __testLinkState({ ...CFG2, push: T1 }, sock)
    const deps = { pushKey: async () => KEY, sendPush: async (_k: PushKey, t: typeof T1) => (pushes.push(t), reply) }
    return { st, sent, pushes, deps }
  }
  const settle = () => new Promise((r) => setTimeout(r, 0))

  it('an answer kept while the socket was closed wakes the phone when it goes out', async () => {
    const { st, pushes, deps } = pushing()
    const sock = st.ws as unknown as { readyState: number }
    sock.readyState = 3
    await handlePhoneFrame(st, { type: 'say', id: 'w2', text: '全体どう?', projectId: 'assistant' }, {
      ...deps,
      assistant: async () => ({ reply: '全部順調' }),
    })
    await settle()
    expect(pushes).toEqual([])
    sock.readyState = 1
    flushAssistantOutbox(st, deps) // what tick does once the socket is back
    await settle()
    expect(pushes).toEqual([T1])
  })

  it("the assistant's answer wakes a locked phone once it is out", async () => {
    const { st, sent, pushes, deps } = pushing()
    await handlePhoneFrame(st, { type: 'say', id: 'w1', text: '全体どう?', projectId: 'assistant' }, {
      ...deps,
      assistant: async () => ({ reply: '全部順調' }),
    })
    await settle()
    expect(sent.some((f) => f.kind === 'assistant')).toBe(true)
    expect(pushes).toEqual([T1])
  })

  it('the phone token is kept with the keys (0600), replaced by a newer one, and forgotten on request', async () => {
    const st = __testLinkState(CFG, fakeSocket().sock)
    await handlePhoneFrame(st, { type: 'push-token', ...T1 })
    expect((await readPhoneLinkConfig())?.push).toEqual(T1)
    expect(statSync(cfgFile()).mode & 0o777).toBe(0o600)
    await handlePhoneFrame(st, { type: 'push-token', ...T2 })
    expect((await readPhoneLinkConfig())?.push).toEqual(T2) // the newest wins
    // Not a token (it would go into the APNs request path): ignored, the old one stays.
    await handlePhoneFrame(st, { type: 'push-token', ...T1, token: '../../x' })
    await handlePhoneFrame(st, { type: 'push-token', ...T1, topic: 'com.x.app' })
    expect((await readPhoneLinkConfig())?.push).toEqual(T2)
    await handlePhoneFrame(st, { type: 'push-token', token: null })
    expect((await readPhoneLinkConfig())?.push).toBeUndefined()
  })

  it('what the phone reads aloud wakes it — at most once per few seconds while the president keeps writing', async () => {
    h.file = join(dir, 'push1.jsonl')
    writeFileSync(h.file, '')
    const { st, pushes, deps } = pushing()
    await pumpTranscript(st, deps)
    appendFileSync(h.file, user('進めて') + '\n') // the owner's own words: nothing to wake for
    await pumpTranscript(st, deps)
    await settle()
    expect(pushes).toEqual([])
    appendFileSync(h.file, asst([{ type: 'text', text: '了解です' }]) + '\n' + user(`${SUPPLY_NOTICE_PREFIX}完成しました`) + '\n')
    await pumpTranscript(st, deps)
    await settle()
    expect(pushes).toEqual([T1])
    appendFileSync(h.file, asst([{ type: 'text', text: '続きです' }]) + '\n')
    await pumpTranscript(st, deps)
    await settle()
    expect(pushes).toHaveLength(1) // within the gap: owed, not sent
    expect(st.pushOwed).toBe(true)
    st.pushedAt -= PUSH_GAP_MS // the gap is over (the timer's moment)
    await flushPush(st, deps)
    expect(pushes).toHaveLength(2)
    clearTimeout(st.pushTimer)
  })

  it('no push while a say from the phone has no final ack; it goes once the ack went out', async () => {
    h.desk = true
    h.file = join(dir, 'push2.jsonl')
    writeFileSync(h.file, '')
    const { st, sent, pushes, deps } = pushing()
    let busy = true
    const desk = fakeDesk()
    const supply = { ...desk.deps, screen: () => desk.deps.screen() + (busy ? ' · esc to interrupt' : '') }
    await pumpTranscript(st, deps)
    await handlePhoneFrame(st, { type: 'say', id: 's1', text: '状況は?' }, { ...deps, supply })
    expect(sent.filter((f) => f.type === 'ack').map((f) => f.state)).toEqual(['queued'])
    appendFileSync(h.file, asst([{ type: 'text', text: 'まだ前の返事を書いています' }]) + '\n')
    await pumpTranscript(st, deps)
    await settle()
    expect(pushes).toEqual([]) // held: the owner just spoke
    busy = false
    await flushSupplyNotices(supply)
    expect(sent.filter((f) => f.type === 'ack').map((f) => f.state)).toEqual(['queued', 'delivered'])
    await vi.waitFor(() => expect(pushes).toEqual([T1]))
    clearTimeout(st.pushTimer)
  })

  it('a say that never lands holds pushes for a while, not for good', async () => {
    h.desk = true
    const { st, pushes, deps } = pushing()
    const desk = fakeDesk()
    const supply = { ...desk.deps, screen: () => desk.deps.screen() + ' · esc to interrupt' }
    await handlePhoneFrame(st, { type: 'say', id: 's2', text: 'もしもし' }, { ...deps, supply })
    st.pushOwed = true
    await flushPush(st, deps)
    expect(pushes).toEqual([])
    for (const hold of Array.from(st.says)) hold.at -= SAY_HOLD_MAX_MS
    await flushPush(st, deps)
    expect(pushes).toEqual([T1])
    clearTimeout(st.pushTimer)
    resetSupplyNoticeState()
  })

  it('a Mac reconnect re-sends what the relay already has, and that wakes nobody', async () => {
    h.file = join(dir, 'push3.jsonl')
    writeFileSync(h.file, '')
    const { st, sent, pushes, deps } = pushing()
    await pumpTranscript(st, deps)
    appendFileSync(h.file, asst([{ type: 'text', text: '一つ目' }, { type: 'text', text: '二つ目' }]) + '\n')
    await pumpTranscript(st, deps)
    await settle()
    expect(pushes).toHaveLength(1)
    st.pushedAt = 0
    // Reconnect: the relay says it stored the last event; the Mac rewinds to its line and re-sends.
    const last = sent.filter((f) => f.type === 'event').at(-1)!
    await handleRelayFrame(st, { type: 'resume', cur: last.cur })
    expect(await pumpTranscript(st, deps)).toBe(2)
    await settle()
    expect(pushes).toHaveLength(1)
    appendFileSync(h.file, asst([{ type: 'text', text: '新しい話' }]) + '\n')
    await pumpTranscript(st, deps)
    await settle()
    expect(pushes).toHaveLength(2)
    clearTimeout(st.pushTimer)
  })

  it('something said while a push is in flight is still pushed, after the gap', async () => {
    let release = () => {}
    const pushes: PushTarget[] = []
    const st = __testLinkState({ ...CFG, push: T1 }, fakeSocket().sock)
    const deps = {
      pushKey: async () => KEY,
      sendPush: async (_k: PushKey, t: PushTarget) => {
        pushes.push(t)
        if (pushes.length === 1) await new Promise<void>((r) => (release = r))
        return { status: 200 }
      },
    }
    st.pushOwed = true
    const first = flushPush(st, deps)
    await vi.waitFor(() => expect(pushes).toHaveLength(1))
    st.pushOwed = true // a new event while the first push is in flight
    await flushPush(st, deps)
    release()
    await first
    await vi.waitFor(() => expect(st.pushTimer).toBeDefined()) // waits out the gap
    st.pushedAt -= PUSH_GAP_MS
    await flushPush(st, deps)
    expect(pushes).toHaveLength(2)
    clearTimeout(st.pushTimer)
  })

  it('a push lost on the way (no answer, 429, 5xx) is sent again after the gap — a few times, not forever', async () => {
    const answers = [{ status: 0, reason: 'timeout' }, { status: 429, reason: 'TooManyRequests' }, { status: 200 }]
    const pushes: PushTarget[] = []
    const st = __testLinkState({ ...CFG, push: T1 }, fakeSocket().sock)
    const deps = { pushKey: async () => KEY, sendPush: async (_k: PushKey, t: PushTarget) => (pushes.push(t), answers[pushes.length - 1] ?? { status: 200 }) }
    const gapOver = async () => {
      await vi.waitFor(() => expect(st.pushing).toBe(false))
      st.pushedAt -= PUSH_GAP_MS
      await flushPush(st, deps)
    }
    st.pushOwed = true
    await flushPush(st, deps)
    expect(pushes).toHaveLength(1)
    expect(st.pushOwed).toBe(true) // owed again, not lost
    await gapOver()
    await gapOver()
    expect(pushes).toHaveLength(3) // delivered on the third try
    expect(st.pushOwed).toBe(false)
    // Apple never answers: PUSH_RETRY_MAX more tries, then it stops.
    const down = pushing({ status: 503, reason: 'ServiceUnavailable' })
    down.st.pushOwed = true
    await flushPush(down.st, down.deps)
    for (let i = 0; i < PUSH_RETRY_MAX + 3; i++) {
      await vi.waitFor(() => expect(down.st.pushing).toBe(false))
      down.st.pushedAt -= PUSH_GAP_MS
      await flushPush(down.st, down.deps)
    }
    expect(down.pushes).toHaveLength(1 + PUSH_RETRY_MAX)
    expect(down.st.pushOwed).toBe(false)
    clearTimeout(st.pushTimer)
    clearTimeout(down.st.pushTimer)
  })

  it('a refusal Apple will repeat stops the pushes until the key or the token changes, and Settings says so', async () => {
    rmSync(join(openGroundHome(), 'phone-link.json'), { force: true })
    expect(await savePushKey(KEY)).toEqual({ ok: true })
    const status = async () => (await phoneLinkRoutes.request('/api/phone-link', { headers: { host: '127.0.0.1:47776' } })).json()
    for (const reply of [
      { status: 403, reason: 'BadEnvironmentKeyIdInToken' },
      { status: 403, reason: 'InvalidProviderToken' },
      { status: 400, reason: 'DeviceTokenNotForTopic' },
    ]) {
      const { st, pushes, deps } = pushing(reply)
      deps.pushKey = async () => KEY
      await handlePhoneFrame(st, { type: 'push-token', ...T1 }) // saved
      st.pushOwed = true
      await flushPush(st, deps)
      expect(pushes).toHaveLength(1)
      expect(await status()).toMatchObject({ pushRefused: reply.reason, pushPhone: true })
      for (let i = 0; i < 3; i++) {
        st.pushedAt -= PUSH_GAP_MS
        st.pushOwed = true
        await flushPush(st, deps)
      }
      expect(pushes).toHaveLength(1) // not retried on every event
      expect(st.cfg.push).toEqual(T1) // the token is kept (it is not the token's fault)
      // A new token from the phone: tried again.
      await handlePhoneFrame(st, { type: 'push-token', ...T2 })
      expect((await status()).pushRefused).toBeNull()
      st.pushOwed = true
      st.pushedAt -= PUSH_GAP_MS
      await flushPush(st, deps)
      expect(pushes).toHaveLength(2)
      // Refused again; then the owner enters a corrected key: tried again.
      const fixed = { ...KEY, p8: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
      deps.pushKey = async () => fixed
      st.pushOwed = true
      st.pushedAt -= PUSH_GAP_MS
      await flushPush(st, deps)
      expect(pushes).toHaveLength(3)
      clearTimeout(st.pushTimer)
    }
  })

  it('Settings blames the key for a 403 and the iPhone app for a token / topic refusal', async () => {
    rmSync(join(openGroundHome(), 'phone-link.json'), { force: true })
    expect(await savePushKey(KEY)).toEqual({ ok: true })
    const status = async () => (await phoneLinkRoutes.request('/api/phone-link', { headers: { host: '127.0.0.1:47776' } })).json()
    for (const [reply, by] of [
      [{ status: 403, reason: 'InvalidProviderToken' }, 'key'],
      [{ status: 400, reason: 'BadTopic' }, 'app'],
      [{ status: 400, reason: 'TopicDisallowed' }, 'key'], // a topic-specific key not covering the app
    ] as const) {
      const { st, deps } = pushing(reply)
      await handlePhoneFrame(st, { type: 'push-token', ...T1 })
      st.pushOwed = true
      st.pushRetries = 2 // two tries lost before: the next event starts afresh
      await flushPush(st, deps)
      expect(await status()).toMatchObject({ pushRefused: reply.reason, pushRefusedBy: by })
      expect(st.pushRetries).toBe(0)
      // The app reopened hands over the SAME token: an app refusal is tried again, a key refusal stays.
      await handlePhoneFrame(st, { type: 'push-token', ...T1 })
      expect((await status()).pushRefused).toBe(by === 'app' ? null : reply.reason)
    }
  })

  it('an expired provider token (403 ExpiredProviderToken) is signed anew and the push retried — never a lasting refusal', async () => {
    rmSync(join(openGroundHome(), 'phone-link.json'), { force: true })
    expect(await savePushKey(KEY)).toEqual({ ok: true })
    const answers = [{ status: 403, reason: 'ExpiredProviderToken' }, { status: 200 }]
    const pushes: PushTarget[] = []
    const jwts: unknown[] = []
    const st = __testLinkState({ ...CFG, push: T1 }, fakeSocket().sock)
    const deps = {
      pushKey: async () => KEY,
      sendPush: async (_k: PushKey, t: PushTarget) => {
        jwts.push(globalThis.__openground_apns_jwt)
        return (pushes.push(t), answers[pushes.length - 1] ?? { status: 200 })
      },
    }
    globalThis.__openground_apns_jwt = { id: 'cached', token: 'stale.jwt.sig', at: Date.now() - JWT_MIN_AGE_MS }
    st.pushOwed = true
    await flushPush(st, deps)
    expect(globalThis.__openground_apns_jwt).toBeUndefined() // the next push signs a fresh one
    expect(st.cfg.pushRefused).toBeUndefined()
    expect(st.pushOwed).toBe(true) // owed again
    await vi.waitFor(() => expect(st.pushing).toBe(false))
    st.pushedAt -= PUSH_GAP_MS
    await flushPush(st, deps)
    expect(pushes).toHaveLength(2)
    expect(jwts[0]).toMatchObject({ id: 'cached' })
    expect((await (await phoneLinkRoutes.request('/api/phone-link', { headers: { host: '127.0.0.1:47776' } })).json()).pushRefused).toBeNull()
    clearTimeout(st.pushTimer)
    // The Mac's clock is off: every answer is "expired". Retried within the cap,
    // then it waits for the next event — and a token younger than Apple's 20 min
    // floor is not signed anew (TooManyProviderTokenUpdates).
    const down = pushing({ status: 403, reason: 'ExpiredProviderToken' })
    const young = { id: 'young', token: 'young.jwt.sig', at: Date.now() }
    globalThis.__openground_apns_jwt = young
    down.st.pushOwed = true
    await flushPush(down.st, down.deps)
    for (let i = 0; i < PUSH_RETRY_MAX + 3; i++) {
      await vi.waitFor(() => expect(down.st.pushing).toBe(false))
      down.st.pushedAt -= PUSH_GAP_MS
      await flushPush(down.st, down.deps)
    }
    expect(down.pushes).toHaveLength(1 + PUSH_RETRY_MAX)
    expect(down.st.pushOwed).toBe(false)
    expect(down.st.pushRetries).toBe(0)
    expect(down.st.cfg.pushRefused).toBeUndefined()
    expect(globalThis.__openground_apns_jwt).toBe(young)
    clearTimeout(down.st.pushTimer)
  })

  it('entering the key in Settings — even the same key — clears a stored refusal, live or not', async () => {
    const save = () =>
      phoneLinkRoutes.request('/api/phone-link/push-key', {
        method: 'POST',
        headers: { host: '127.0.0.1:47776', 'content-type': 'application/json' },
        body: JSON.stringify(KEY),
      })
    const status = async () => (await phoneLinkRoutes.request('/api/phone-link', { headers: { host: '127.0.0.1:47776' } })).json()
    expect(await savePushKey(KEY)).toEqual({ ok: true })
    // Live link: refused, then the same key again — pushed again.
    const { st, pushes, deps } = pushing({ status: 403, reason: 'InvalidProviderToken' })
    await handlePhoneFrame(st, { type: 'push-token', ...T1 })
    st.pushOwed = true
    await flushPush(st, deps)
    expect((await status()).pushRefused).toBe('InvalidProviderToken')
    globalThis.__openground_phone_link = st
    try {
      expect((await save()).status).toBe(200)
    } finally {
      globalThis.__openground_phone_link = undefined
    }
    expect(st.cfg.pushRefused).toBeUndefined()
    expect((await status()).pushRefused).toBeNull()
    st.pushOwed = true
    st.pushedAt -= PUSH_GAP_MS
    await flushPush(st, deps)
    expect(pushes).toHaveLength(2)
    // No live link (app restarted without the relay): the saved refusal goes from disk.
    expect((await readPhoneLinkConfig())?.pushRefused).toBeDefined()
    expect((await save()).status).toBe(200)
    expect((await readPhoneLinkConfig())?.pushRefused).toBeUndefined()
    expect((await readPhoneLinkConfig())?.push).toEqual(T1)
    clearTimeout(st.pushTimer)
  })

  it('a token APNs calls dead (410, BadDeviceToken) is forgotten; any other refusal keeps it', async () => {
    for (const [reply, kept] of [
      [{ status: 410, reason: 'Unregistered' }, false],
      [{ status: 400, reason: 'BadDeviceToken' }, false],
      [{ status: 403, reason: 'InvalidProviderToken' }, true],
      [{ status: 0, reason: 'connect' }, true],
    ] as const) {
      const { st, pushes, deps } = pushing(reply)
      st.pushOwed = true
      st.pushRetries = 2
      await flushPush(st, deps)
      expect(pushes).toHaveLength(1)
      expect(st.cfg.push).toEqual(kept ? T1 : undefined)
      if (!kept) expect(st.pushRetries).toBe(0)
      clearTimeout(st.pushTimer)
    }
    // Saved, then dropped ON DISK too.
    const { st, deps } = pushing({ status: 410 })
    await handlePhoneFrame(st, { type: 'push-token', ...T1 })
    expect((await readPhoneLinkConfig())?.push).toEqual(T1)
    st.pushOwed = true
    await flushPush(st, deps)
    expect((await readPhoneLinkConfig())?.push).toBeUndefined()
  })

  it('without a token, without the APNs key, or under work mode, nothing is pushed', async () => {
    const a = pushing()
    a.st.cfg = CFG
    a.st.pushOwed = true
    await flushPush(a.st, a.deps)
    const b = pushing()
    b.st.pushOwed = true
    await flushPush(b.st, { ...b.deps, pushKey: async () => null })
    const c = pushing()
    c.st.pushOwed = true
    setLockdownCache(true)
    await flushPush(c.st, c.deps)
    expect([...a.pushes, ...b.pushes, ...c.pushes]).toEqual([])
    expect([a.st.pushOwed, b.st.pushOwed, c.st.pushOwed]).toEqual([false, false, false])
  })

  it('the Mac tells the relay it can push; pairing again drops the token; the key is never handed back', async () => {
    const frames: Record<string, unknown>[] = []
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    wss.on('connection', (ws) =>
      ws.on('message', (m) => {
        const f = JSON.parse(String(m))
        frames.push(f)
        if (f.type === 'reset') ws.close(1000)
      }),
    )
    await new Promise((r) => wss.once('listening', r))
    const relayUrl = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`
    try {
      writeFileSync(cfgFile(), JSON.stringify({ ...CFG, relayUrl, push: T1 }), { mode: 0o600 })
      rmSync(join(openGroundHome(), 'phone-push-key.json'), { force: true })
      expect(await startPhoneLink()).toBe(true)
      await vi.waitFor(() => expect(frames.find((f) => f.type === 'push-ready')).toEqual({ type: 'push-ready', on: false }))
      // The owner enters the key in Settings: the relay hears it on the same socket.
      const put = await phoneLinkRoutes.request('/api/phone-link/push-key', {
        method: 'POST',
        headers: { host: '127.0.0.1:47776', 'content-type': 'application/json' },
        body: JSON.stringify(KEY),
      })
      expect(put.status).toBe(200)
      await vi.waitFor(() => expect(frames.filter((f) => f.type === 'push-ready').at(-1)).toEqual({ type: 'push-ready', on: true }))
      expect(wss.clients.size).toBe(1) // not a reconnect
      // Nothing secret ever went to the relay: not the key, its ID, nor the phone token.
      const wire = JSON.stringify(frames)
      for (const secret of ['PRIVATE KEY', P8.split('\n')[1], KEY.keyId, KEY.teamId, T1.token]) expect(wire).not.toContain(secret)
      const status = await phoneLinkRoutes.request('/api/phone-link', { headers: { host: '127.0.0.1:47776' } })
      const body = await status.text()
      expect(JSON.parse(body)).toMatchObject({ pushKeyId: KEY.keyId, pushPhone: true })
      expect(body).not.toContain('PRIVATE KEY')
      expect(body).not.toContain(T1.token)
      process.env.OPENGROUND_PHONE_RELAY_URL = relayUrl
      const paired = await pairPhone()
      expect(paired).toHaveProperty('code')
      expect((await readPhoneLinkConfig())?.push).toBeUndefined()
    } finally {
      delete process.env.OPENGROUND_PHONE_RELAY_URL
      stopPhoneLink()
      rmSync(cfgFile(), { force: true })
      wss.close()
    }
  })

  it('the Mac carries the app key that lets it create its room; without it the relay refuses and pairing fails', async () => {
    // A relay that, like worker/src/phoneRelay.ts, creates a room only for a Mac
    // with the app key, and lets the Mac that made it back in with its key alone.
    const seen: (string | undefined)[] = []
    const rooms = new Map<string, string>()
    const wss = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      verifyClient: ({ req }, cb) => {
        const app = req.headers['x-og-app-key'] as string | undefined
        const mac = String(req.headers['x-og-token'])
        seen.push(app)
        const made = rooms.get(String(req.url))
        if (made !== undefined) return cb(made === mac, 401)
        if (app !== 'app-pass-1') return cb(false, 401)
        rooms.set(String(req.url), mac)
        cb(true)
      },
    })
    await new Promise((r) => wss.once('listening', r))
    process.env.OPENGROUND_PHONE_RELAY_URL = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      rmSync(cfgFile(), { force: true })
      expect(await pairPhone()).toEqual({ error: 'relay-unreachable' })
      expect(await readPhoneLinkConfig()).toBeNull()
      // The relay answered 401: the log names the missing app key.
      expect(warn.mock.calls.some((c) => String(c[0]).includes('no OPENGROUND_PHONE_RELAY_APP_KEY'))).toBe(true)
      warn.mockClear()
      process.env.OPENGROUND_PHONE_RELAY_APP_KEY = 'app-pass-1'
      expect(await pairPhone()).toHaveProperty('code')
      expect(seen).toEqual([undefined, 'app-pass-1', ...seen.slice(2)])
      // The link itself dials with it too.
      await vi.waitFor(() => expect(wss.clients.size).toBe(1))
      expect(seen.every((s, i) => i === 0 || s === 'app-pass-1')).toBe(true)
      // Pairing again from a build the relay refuses keeps the pairing that works:
      // the new room is asked for BEFORE the old one is unlinked.
      const resets: unknown[] = []
      wss.on('connection', (ws) => ws.on('message', (m) => String(m).includes('"reset"') && resets.push(m)))
      const before = await readPhoneLinkConfig()
      delete process.env.OPENGROUND_PHONE_RELAY_APP_KEY
      expect(await pairPhone()).toEqual({ error: 'relay-unreachable' })
      expect(await readPhoneLinkConfig()).toEqual(before)
      await new Promise((r) => setTimeout(r, 100))
      expect(resets).toEqual([])
    } finally {
      warn.mockRestore()
      delete process.env.OPENGROUND_PHONE_RELAY_URL
      delete process.env.OPENGROUND_PHONE_RELAY_APP_KEY
      stopPhoneLink()
      rmSync(cfgFile(), { force: true })
      wss.close()
    }
  })

  it('a relay that cannot be reached at all is not blamed on the missing app key', async () => {
    // A port nobody listens on: connection refused, no HTTP answer at all.
    const probe = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise((r) => probe.once('listening', r))
    const port = (probe.address() as AddressInfo).port
    await new Promise((r) => probe.close(r))
    process.env.OPENGROUND_PHONE_RELAY_URL = `http://127.0.0.1:${port}`
    delete process.env.OPENGROUND_PHONE_RELAY_APP_KEY
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      rmSync(cfgFile(), { force: true })
      expect(await pairPhone()).toEqual({ error: 'relay-unreachable' })
      expect(warn.mock.calls.some((c) => String(c[0]).includes('OPENGROUND_PHONE_RELAY_APP_KEY'))).toBe(false)
    } finally {
      warn.mockRestore()
      delete process.env.OPENGROUND_PHONE_RELAY_URL
      stopPhoneLink()
      rmSync(cfgFile(), { force: true })
    }
  })

  it('the APNs key route refuses a bad key and keeps nothing', async () => {
    const r = await phoneLinkRoutes.request('/api/phone-link/push-key', {
      method: 'POST',
      headers: { host: '127.0.0.1:47776', 'content-type': 'application/json' },
      body: JSON.stringify({ p8: 'x', keyId: 'ABC123DEFG', teamId: 'TEAM123456' }),
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'bad-key' })
  })
})

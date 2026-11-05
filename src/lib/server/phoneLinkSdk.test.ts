// The iOS wire contract through the real SDK pool and president owner lane.
// Only Responses HTTP/auth and the permission lookup are synthetic: no model,
// CLI, relay socket, or live desk is contacted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { registerTestProject } from '../../test/registerProject'
import { createChatGptQuery, distillChatGptMessage, chatGptTranscriptFile } from './chatgptQuery'
import { __testLinkState, handleRelayFrame, pumpTranscript, type PhoneLinkConfig } from './phoneLink'
import { e2eKeyOf, open, seal } from './phoneLinkSeal'
import { getSdkSession, removeSdkSession, spawnSdkSession, terminateSdkSession } from './sdkSession'
import { setLockdownCache } from './lockdown'
import { openGroundHome } from './paths'
import { resetSupplyNoticeState } from './supplyNotice'
import { recordSwarmSession } from './swarmSessions'
import { pushSupplyInput, supplyTranscriptFile } from './swarmSupplyRuntime'

vi.mock('./assistantAccess', () => ({ hasAssistantAccess: async () => true }))
vi.mock('./terminal', async (original) => ({
  ...(await original<typeof import('./terminal')>()),
  listOwnerDeskTerminals: () => [],
  listLiveDesksIn: () => [],
}))

type Frame = Record<string, unknown>
const ownedSessions: string[] = []
const releases: (() => void)[] = []

beforeEach(() => {
  setLockdownCache(false)
  resetSupplyNoticeState()
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const id of ownedSessions.splice(0)) {
    terminateSdkSession(id)
    await vi.waitFor(() => expect(getSdkSession(id)?.reaped).toBe(true))
    removeSdkSession(id)
  }
  resetSupplyNoticeState()
  await rm(join(openGroundHome(), 'phone-link.json'), { force: true })
})

const fixture = async (holdText?: string) => {
  await mkdir(openGroundHome(), { recursive: true })
  const cwd = await realpath(await mkdtemp(join(openGroundHome(), 'phone-sdk-project-')))
  const projectId = await registerTestProject(cwd)
  const agentSessionId = `chatgpt-${randomUUID()}`
  const calls: string[] = []
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  releases.push(release)
  const queryFn = createChatGptQuery({
    accountKey: async () => 'phone-sdk-fixture-account',
    accessToken: async () => 'synthetic-subscription-token',
    authorize: async () => {},
    roleInstructions: async () => 'Synthetic president conversation.',
    fetch: (async (_url, init) => {
      const request = JSON.parse(init!.body as string) as { input: { role?: string; content?: string }[] }
      const text = request.input.filter((entry) => entry.role === 'user').at(-1)?.content
      if (typeof text !== 'string') throw new Error('missing fixture input')
      calls.push(text)
      if (text === holdText) {
        await Promise.race([
          held,
          new Promise<never>((_, reject) => {
            if (init?.signal?.aborted) reject(new Error('fixture aborted'))
            else init?.signal?.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true })
          }),
        ])
      }
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {
        status: 'completed', model: 'fixture-model',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `President reply: ${text}` }] }],
      } })}\n\n`)
    }) as typeof fetch,
  })
  const session = spawnSdkSession({
    cwd, role: 'supply', provider: 'chatgpt', agentSessionId,
    options: { cwd, model: 'fixture-model', runtimeRole: 'supply', sessionId: agentSessionId },
    initialPrompt: '/supply', queryFn, distillMessage: distillChatGptMessage,
  })
  ownedSessions.push(session.id)
  await recordSwarmSession(cwd, 'supply', agentSessionId)
  const transcript = chatGptTranscriptFile(agentSessionId)
  const ready = async (lastText: string) => vi.waitFor(async () => {
    expect(getSdkSession(session.id)?.status).toBe('waiting')
    expect(await readFile(transcript, 'utf8')).toContain(`President reply: ${lastText}`)
  })
  await ready('/supply')
  const e2eKey = randomBytes(32).toString('base64url')
  const key = e2eKeyOf(e2eKey)!
  const cfg: PhoneLinkConfig = { v: 2, relayUrl: 'https://relay.test', macKey: 'm'.repeat(43), phoneKey: 'p'.repeat(43), e2eKey, projectId, quiet: 0 }
  const sent: Frame[] = []
  const sock = { readyState: 1, send: (wire: string) => {
    const outer = JSON.parse(wire) as Frame
    expect(typeof outer.box).toBe('string')
    sent.push(open(key, 'm2p', outer.box)!)
  } }
  const state = __testLinkState(cfg, sock)
  const phone = (type: string, id: string, extra: Frame = {}) => ({ type, id, box: seal(key, 'p2m', { type, id, projectId, ts: Date.now(), ...extra }) })
  const states = (id: string) => sent.filter((frame) => frame.type === 'ack' && frame.id === id).map((frame) => frame.state)
  return { cwd, projectId, session, transcript, calls, cfg, sock, sent, state, phone, states, ready, release }
}

describe('sealed iOS phone link with a ChatGPT SDK president', () => {
  it('delivers an owner turn, tails the SDK reply after reconnect, and retains history without replaying the instruction', async () => {
    const f = await fixture()
    expect(await supplyTranscriptFile(f.cwd)).toBe(f.transcript)
    expect(await pumpTranscript(f.state)).toBe(0) // paired now: skip startup
    const frame = f.phone('say', 'mobile-owner-1', { text: 'Please summarize this project.' })
    await handleRelayFrame(f.state, frame)
    await f.ready('Please summarize this project.')
    expect(f.states('mobile-owner-1')).toEqual(['queued', 'delivered', 'replying'])
    expect(f.calls).toEqual(['/supply', 'Please summarize this project.'])

    // A disconnected phone cannot advance the transcript cursor or lose a turn.
    f.sock.readyState = 3
    expect(await pumpTranscript(f.state)).toBe(0)
    f.sock.readyState = 1
    expect(await pumpTranscript(f.state)).toBe(2)
    expect(f.sent.filter((entry) => entry.type === 'event')).toEqual([
      expect.objectContaining({ projectId: f.projectId, kind: 'owner', id: 'mobile-owner-1', text: 'Please summarize this project.' }),
      expect.objectContaining({ projectId: f.projectId, kind: 'president', text: 'President reply: Please summarize this project.' }),
    ])
    expect(f.states('mobile-owner-1')).toEqual(['queued', 'delivered', 'replying', 'replied'])
    expect(await pumpTranscript(f.state)).toBe(0)

    // A fresh link can recover the president talk with the same phone contract.
    const reconnected = __testLinkState({ ...f.state.cfg }, f.sock)
    await handleRelayFrame(reconnected, f.phone('assistant-history', 'history-1', { talk: true }))
    expect(f.sent.find((entry) => entry.type === 'assistant-history' && entry.id === 'history-1')).toMatchObject({
      projectId: f.projectId,
      talk: expect.arrayContaining([
        expect.objectContaining({ kind: 'owner', text: 'Please summarize this project.' }),
        expect.objectContaining({ kind: 'president', text: 'President reply: Please summarize this project.' }),
      ]),
    })
    await handleRelayFrame(reconnected, frame)
    expect(f.calls).toHaveLength(2)
    expect(getSdkSession(f.session.id)?.inputs).toBe(2)
  })

  it('queues one fresh turn while working, drops a duplicate, and refuses a closed desk without spawning a replacement', async () => {
    const f = await fixture('First mobile command')
    await handleRelayFrame(f.state, f.phone('say', 'working-1', { text: 'First mobile command' }))
    await vi.waitFor(() => expect(f.calls).toEqual(['/supply', 'First mobile command']))
    expect(getSdkSession(f.session.id)?.status).toBe('working')
    const queued = f.phone('say', 'working-2', { text: 'Second mobile command' })
    await handleRelayFrame(f.state, queued)
    await handleRelayFrame(f.state, queued)
    expect(f.states('working-2')).toEqual(['queued', 'delivered', 'replying'])
    expect(f.calls).toHaveLength(2)
    f.release()
    await f.ready('Second mobile command')
    expect(f.calls).toEqual(['/supply', 'First mobile command', 'Second mobile command'])
    expect(getSdkSession(f.session.id)?.inputs).toBe(3)

    terminateSdkSession(f.session.id)
    expect(pushSupplyInput(f.session.id, 'must never be delivered')).toBe(false)
    await vi.waitFor(() => expect(getSdkSession(f.session.id)?.reaped).toBe(true))
    const wakeDesk = vi.fn(async () => 'Synthetic closed desk: restart is intentionally unavailable')
    await handleRelayFrame(f.state, f.phone('say', 'closed-1', { text: 'Cannot reach a closed desk' }), { wakeDesk })
    expect(wakeDesk).toHaveBeenCalledExactlyOnceWith(f.cwd)
    expect(f.states('closed-1')).toEqual(['rejected'])
    expect(f.sent.find((entry) => entry.id === 'closed-1')).toMatchObject({ reason: 'desk-failed' })
    expect(f.calls).toHaveLength(3)
  })
})

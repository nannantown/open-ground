import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addProjectEntry } from './registry'
import { recordSwarmSession } from './swarmSessions'
import { initializeRuntimeTransitions, updateRuntimeJournal } from './runtimeTransitionStore'
import { getSdkSession, spawnSdkSession, terminateSdkSession } from './sdkSession'
import type { SdkEvent } from './sdkEvents'
import { defaultManagerPresence, defaultNotifyManagerReady, defaultNudgeManager } from './swarmOrchestrator'

let project: string
const handles: string[] = []
beforeEach(async () => {
  const home = join(process.env.OPENGROUND_HOME!, `manager-delivery-${randomUUID()}`)
  project = join(home, 'project')
  await mkdir(project, { recursive: true })
  await mkdir(join(home, 'og'), { recursive: true })
  vi.stubEnv('HOME', home)
  vi.stubEnv('OPENGROUND_HOME', join(home, 'og'))
  await addProjectEntry(project)
})
afterEach(async () => {
  for (const id of handles.splice(0)) {
    terminateSdkSession(id)
    await vi.waitFor(() => expect(getSdkSession(id)?.reaped).toBe(true))
  }
  vi.unstubAllEnvs()
})

const select = async (provider: 'claude' | 'chatgpt') => initializeRuntimeTransitions({
  assistant: { provider: 'claude' }, swarm: { provider },
})
/** The real pool and input controller, with a provider that only records words. */
const manager = (provider: 'claude' | 'chatgpt') => {
  const sessionId = `${provider === 'chatgpt' ? 'chatgpt-' : ''}${randomUUID()}`
  const received: string[] = []
  const session = spawnSdkSession({ cwd: project, role: 'manager', ...(provider === 'chatgpt' ? { provider } : {}), agentSessionId: sessionId,
    options: {}, distillMessage: message => [message as SdkEvent], queryFn: params => ({
      interrupt: async () => {},
      async *[Symbol.asyncIterator]() {
        for await (const input of params.prompt) {
          received.push((input as { message: { content: { text: string }[] } }).message.content[0].text)
          yield { kind: 'text', text: 'Synthetic manager received the instruction.' }
          await params.onTurnSettled?.()
        }
      },
    }),
  })
  handles.push(session.id)
  return { sessionId, received }
}

describe('manager control uses the admitted provider and the actual live handle', () => {
  it.each([false, true])('delivers to a ChatGPT-only record with an old Claude record=%s', async oldRecord => {
    await select('chatgpt')
    if (oldRecord) await recordSwarmSession(project, 'manager', randomUUID())
    const gpt = manager('chatgpt')
    await recordSwarmSession(project, 'manager', gpt.sessionId)
    expect(await defaultManagerPresence(project, Date.now())).not.toBe('absent')
    expect(await defaultNudgeManager(project)).toBe(true)
    expect(await defaultNotifyManagerReady(project, { text: 'The completed work is ready for review.' })).toBe(true)
    await vi.waitFor(() => expect(gpt.received).toEqual([
      expect.stringContaining('統合待ちのカードがあります'), 'The completed work is ready for review.',
    ]))
  })

  it('does not send to a live old Claude manager when the admitted manager is ChatGPT', async () => {
    await select('chatgpt')
    const claude = manager('claude'), gpt = manager('chatgpt')
    await recordSwarmSession(project, 'manager', claude.sessionId)
    await recordSwarmSession(project, 'manager', gpt.sessionId)
    expect(await defaultNudgeManager(project)).toBe(true)
    expect(await defaultNotifyManagerReady(project, { text: 'Only the admitted manager may receive this.' })).toBe(true)
    await vi.waitFor(() => expect(gpt.received).toHaveLength(2))
    expect(claude.received).toEqual([])
  })

  it('uses the unique live ChatGPT handle when its persisted slot is stale', async () => {
    await select('chatgpt')
    const gpt = manager('chatgpt')
    await recordSwarmSession(project, 'manager', `chatgpt-${randomUUID()}`)
    expect(await defaultNudgeManager(project)).toBe(true)
    await vi.waitFor(() => expect(gpt.received).toHaveLength(1))
  })

  it.each(['claude', 'chatgpt'] as const)('keeps ambiguous %s desks occupied but sends to neither of them', async provider => {
    await select(provider)
    const first = manager(provider), second = manager(provider)
    await recordSwarmSession(project, 'manager', second.sessionId)
    expect(await defaultManagerPresence(project, Date.now())).not.toBe('absent')
    expect(await defaultNudgeManager(project)).toBe(false)
    expect(await defaultNotifyManagerReady(project, { text: 'Must remain queued.' })).toBe(false)
    expect(first.received).toEqual([])
    expect(second.received).toEqual([])
  })

  it('does not address another provider when only its old manager is still alive', async () => {
    await select('chatgpt')
    const claude = manager('claude')
    await recordSwarmSession(project, 'manager', claude.sessionId)
    expect(await defaultManagerPresence(project, Date.now())).not.toBe('absent')
    expect(await defaultNudgeManager(project)).toBe(false)
    expect(await defaultNotifyManagerReady(project, { text: 'Must not reach the previous provider.' })).toBe(false)
    expect(claude.received).toEqual([])
  })

  it('holds new manager instructions throughout a provider handoff', async () => {
    await select('claude')
    const claude = manager('claude'), gpt = manager('chatgpt')
    await recordSwarmSession(project, 'manager', claude.sessionId)
    await recordSwarmSession(project, 'manager', gpt.sessionId)
    await updateRuntimeJournal(journal => {
      journal.scopes.swarm.phase = 'draining'
      journal.scopes.swarm.desired = { provider: 'chatgpt' }
      journal.scopes.swarm.revision++
    })
    expect(await defaultManagerPresence(project, Date.now())).not.toBe('absent')
    expect(await defaultNudgeManager(project)).toBe(false)
    expect(await defaultNotifyManagerReady(project, { text: 'Wait for the committed provider.' })).toBe(false)
    expect(claude.received).toEqual([])
    expect(gpt.received).toEqual([])
  })

  it('preserves the Claude SDK delivery path', async () => {
    await select('claude')
    const claude = manager('claude')
    await recordSwarmSession(project, 'manager', claude.sessionId)
    expect(await defaultNudgeManager(project)).toBe(true)
    expect(await defaultNotifyManagerReady(project, { text: 'Claude still receives ready notices.' })).toBe(true)
    await vi.waitFor(() => expect(claude.received).toHaveLength(2))
  })

  it('does not submit PTY text after the provider changes during the ESC pause', async () => {
    await select('claude')
    const id = randomUUID()
    await recordSwarmSession(project, 'manager', id)
    const writes: string[] = []
    expect(await defaultNudgeManager(project, {
      activity: () => ({ live: true, lastOutputAt: null, terminalId: 'synthetic-pty' }),
      terminal: () => ({ cwd: project, agentSessionId: id, deskLabel: '司令官' }),
      write: (_id, text) => { writes.push(text); return true },
      sleep: async () => {
        await updateRuntimeJournal(journal => {
          journal.scopes.swarm.effective = { provider: 'chatgpt' }
          journal.scopes.swarm.desired = { provider: 'chatgpt' }
          journal.scopes.swarm.revision++
        })
      },
    })).toBe(false)
    expect(writes).toEqual(['\x1b'])
  })

  it.each(['project', 'session', 'role'] as const)('rejects a named native manager whose actual %s does not match', async mismatch => {
    await select('claude')
    const sid = randomUUID()
    await recordSwarmSession(project, 'manager', sid)
    const writes = vi.fn(() => true)
    const deps = {
      activity: () => ({ live: true, lastOutputAt: null, terminalId: 'foreign-pty' }),
      terminal: () => ({ cwd: mismatch === 'project' ? join(project, 'other-project') : project,
        agentSessionId: mismatch === 'session' ? randomUUID() : sid,
        deskLabel: mismatch === 'role' ? 'task-owner' : '司令官' }),
      write: writes, sleep: async () => {},
      getScreen: () => ['⏺ done.', '─'.repeat(40), '❯ ', '─'.repeat(40), '⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n'),
    }
    const nudged = await defaultNudgeManager(project, deps)
    const notified = await defaultNotifyManagerReady(project, { text: 'Must stay in this project.' }, deps)
    expect(nudged).toBe(false)
    expect(notified).toBe(false)
    expect(writes).not.toHaveBeenCalled()
  })
})

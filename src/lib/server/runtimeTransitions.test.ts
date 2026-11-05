import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntimeTransitionCoordinator, RuntimeTransitionConflict, type RuntimeParticipant, type RuntimePreferencePatch } from './runtimeTransitions'
import { getRuntimeJournal, runtimeAdmissionBlocked, updateRuntimeJournal } from './runtimeTransitionStore'
import type { RuntimeProfile } from '../types'

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
let previousHome: string | undefined
beforeEach(async () => { previousHome = process.env.OPENGROUND_HOME; process.env.OPENGROUND_HOME = await mkdtemp(join(tmpdir(), 'og-transition-')) })
afterEach(() => { process.env.OPENGROUND_HOME = previousHome; vi.restoreAllMocks() })
const fixture = (provider: 'claude' | 'chatgpt' = 'claude') => {
  const events: string[] = []
  let owner = 'owner-a'
  const participants = Object.fromEntries(['assistant', 'swarm'].map((scope) => [scope, {
    drain: vi.fn(async () => { events.push(`drain:${scope}`); return { worktree: '/fixture/work', turn: 'settled' } }),
    retire: vi.fn(async () => { events.push(`retire:${scope}`) }),
    resume: vi.fn(async (profile: RuntimeProfile) => { events.push(`resume:${scope}:${profile.provider}`) }),
    cancel: vi.fn(async () => { events.push(`cancel:${scope}`) }),
  }])) as Record<'assistant' | 'swarm', RuntimeParticipant & { drain: ReturnType<typeof vi.fn>; retire: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }>
  const deps = {
    profiles: async () => ({ assistant: { provider }, swarm: { provider } }),
    ownerKey: async () => owner,
    validate: vi.fn(async () => {}),
    commit: vi.fn(async (_patch: RuntimePreferencePatch) => { events.push('commit') }),
    participant: async (scope: 'assistant' | 'swarm') => participants[scope],
    timeoutMs: 30,
    settled: vi.fn(async () => { events.push('inboxes') }),
  }
  return { deps, participants, events, owner: (next: string) => { owner = next }, coordinator: createRuntimeTransitionCoordinator(deps) }
}

describe('durable runtime handoff', () => {
  it('saves unused ChatGPT model preferences without disturbing either live Claude scope, then uses them on an explicit switch', async () => {
    const f = fixture()
    let preferences: RuntimePreferencePatch = { assistantProvider: 'claude', swarmProvider: 'claude', chatgptModel: 'previous-gpt', chatgptEffort: 'low' }
    f.deps.commit.mockImplementation(async (patch: RuntimePreferencePatch) => { preferences = { ...preferences, ...patch }; f.events.push('commit') })
    const coordinator = createRuntimeTransitionCoordinator({ ...f.deps, preferences: async () => ({ ...preferences }) })
    const patch = { chatgptModel: 'next-gpt', chatgptEffort: 'xhigh' } as const
    const result = await coordinator.request(patch)
    await coordinator.settle()
    expect(f.deps.commit).toHaveBeenCalledExactlyOnceWith(patch)
    expect(getRuntimeJournal()).toMatchObject({ revision: 0 })
    expect(getRuntimeJournal()!.pending).toBeUndefined()
    for (const scope of ['assistant', 'swarm'] as const) {
      expect(result[scope]).toMatchObject({ phase: 'stable', effective: { provider: 'claude' }, desired: { provider: 'claude' } })
      expect(runtimeAdmissionBlocked(scope)).toBe(false)
      expect(f.participants[scope].drain).not.toHaveBeenCalled()
      expect(f.participants[scope].retire).not.toHaveBeenCalled()
      expect(f.participants[scope].resume).not.toHaveBeenCalled()
    }
    expect(f.deps.settled).not.toHaveBeenCalled()
    await coordinator.request({ assistantProvider: 'chatgpt' }); await coordinator.settle()
    expect(f.participants.assistant.resume).toHaveBeenCalledExactlyOnceWith({ provider: 'chatgpt', model: 'next-gpt', effort: 'xhigh' }, expect.anything())
    expect(f.participants.swarm.drain).not.toHaveBeenCalled()
    expect((await coordinator.status()).assistant.effective).toEqual({ provider: 'chatgpt', model: 'next-gpt', effort: 'xhigh' })
  })
  it.each(['assistant', 'swarm'] as const)('cancels a %s switch before retirement without recreating the existing actor', async (scope) => {
    const f = fixture()
    f.participants[scope].drain.mockRejectedValueOnce(new Error('The active turn has not reached a safe boundary.'))
    const patch = scope === 'assistant' ? { assistantProvider: 'chatgpt' } as const : { swarmProvider: 'chatgpt' } as const
    await f.coordinator.request(patch); await f.coordinator.settle()
    const before = await f.coordinator.status()
    expect(before[scope]).toMatchObject({ phase: 'attention', effective: { provider: 'claude' }, desired: { provider: 'chatgpt' } })
    expect(getRuntimeJournal()!.pending).toMatchObject({ retirementStarted: false, committed: false, retired: [] })
    const after = await f.coordinator.control('cancel', scope, before[scope].revision)
    await f.coordinator.settle()
    expect(f.participants[scope].retire).not.toHaveBeenCalled()
    expect(f.participants[scope].resume).not.toHaveBeenCalled()
    expect(after[scope]).toMatchObject({ phase: 'stable', effective: { provider: 'claude' }, desired: { provider: 'claude' } })
    expect(getRuntimeJournal()!.pending).toBeUndefined()
    expect(f.participants[scope].cancel).toHaveBeenCalledTimes(1)
    expect(f.participants[scope].drain).toHaveBeenCalledTimes(1)
    expect(f.deps.commit).not.toHaveBeenCalled()
    expect(f.events).toEqual([`cancel:${scope}`, 'inboxes'])
    expect(runtimeAdmissionBlocked(scope)).toBe(false)
  })
  it.each(['claude', 'chatgpt'] as const)('keeps the admitted %s profile through drain and commits only after retirement', async (initial) => {
    const f = fixture(initial)
    const boundary = deferred<unknown>()
    f.participants.swarm.drain.mockImplementation(async () => boundary.promise)
    const target = initial === 'claude' ? 'chatgpt' : 'claude'
    const result = await f.coordinator.request({ swarmProvider: target })
    expect(result.swarm).toMatchObject({ phase: 'draining', effective: { provider: initial }, desired: { provider: target } })
    expect(runtimeAdmissionBlocked('swarm')).toBe(true)
    expect(runtimeAdmissionBlocked('assistant')).toBe(false)
    expect(f.deps.commit).not.toHaveBeenCalled()
    boundary.resolve({ branch: 'work-stays', confirmedActions: ['one'] })
    await f.coordinator.settle()
    expect(f.events).toEqual(['retire:swarm', 'commit', `resume:swarm:${target}`, 'inboxes'])
    expect((await f.coordinator.status()).swarm).toMatchObject({ phase: 'stable', effective: { provider: target } })
    const file = join(process.env.OPENGROUND_HOME!, 'runtime', 'transitions.json')
    expect(JSON.parse(await readFile(file, 'utf8')).pending).toBeUndefined()
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  })
  it('accepts duplicate intent but refuses a competing window and stale recovery actions', async () => {
    const f = fixture(); const boundary = deferred<unknown>()
    f.participants.assistant.drain.mockImplementation(async () => boundary.promise)
    await f.coordinator.request({ assistantProvider: 'chatgpt' })
    await expect(f.coordinator.request({ assistantProvider: 'chatgpt' })).resolves.toMatchObject({ assistant: { revision: 1 } })
    await expect(f.coordinator.request({ assistantProvider: 'claude' })).rejects.toBeInstanceOf(RuntimeTransitionConflict)
    await expect(f.coordinator.control('cancel', 'assistant', 0)).rejects.toBeInstanceOf(RuntimeTransitionConflict)
    boundary.resolve({}); await f.coordinator.settle()
    expect(f.participants.assistant.retire).toHaveBeenCalledTimes(1)
  })
  it('holds unknown running work after a bounded drain without killing it or committing target settings', async () => {
    const f = fixture()
    f.participants.swarm.drain.mockImplementation(() => new Promise(() => {}))
    await f.coordinator.request({ swarmProvider: 'chatgpt' }); await f.coordinator.settle()
    expect((await f.coordinator.status()).swarm.phase).toBe('attention')
    expect(runtimeAdmissionBlocked('swarm')).toBe(true)
    expect(f.participants.swarm.retire).not.toHaveBeenCalled()
    expect(f.deps.commit).not.toHaveBeenCalled()
  })
  it('keeps the checkpoint after failed launch and retries without retiring twice', async () => {
    const f = fixture()
    f.participants.swarm.resume.mockRejectedValueOnce(new Error('target is offline'))
    await f.coordinator.request({ swarmProvider: 'chatgpt' }); await f.coordinator.settle()
    expect(getRuntimeJournal()!.pending).toMatchObject({ retired: ['swarm'], committed: true, checkpoints: { swarm: { turn: 'settled' } } })
    expect((await f.coordinator.status()).swarm).toMatchObject({ phase: 'attention', effective: { provider: 'claude' }, desired: { provider: 'chatgpt' } })
    await f.coordinator.control('retry', 'swarm', 1); await f.coordinator.settle()
    expect(f.participants.swarm.retire).toHaveBeenCalledTimes(1)
    expect(f.deps.commit).toHaveBeenCalledTimes(1)
    expect(runtimeAdmissionBlocked('swarm')).toBe(false)
  })
  it.each(['draining', 'checkpointed', 'retiring', 'launching', 'attention'] as const)('fresh coordinator holds a recovered %s phase before engine admission', async (phase) => {
    const f = fixture()
    f.participants.swarm.resume.mockRejectedValue(new Error('offline'))
    await f.coordinator.request({ swarmProvider: 'chatgpt' }); await f.coordinator.settle()
    await updateRuntimeJournal((j) => { j.scopes.swarm.phase = phase })
    f.events.length = 0
    const restarted = createRuntimeTransitionCoordinator(f.deps)
    await restarted.initialize()
    expect((await restarted.status()).swarm.phase).toBe('attention')
    expect(f.events).toEqual([])
    expect(runtimeAdmissionBlocked('swarm')).toBe(true)
  })
  it('revokes a drained transition on owner change before retiring any actor', async () => {
    const f = fixture(); const boundary = deferred<unknown>()
    f.participants.swarm.drain.mockImplementation(async () => boundary.promise)
    await f.coordinator.request({ swarmProvider: 'chatgpt' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    f.owner('owner-b'); boundary.resolve({}); await f.coordinator.settle()
    expect(f.participants.swarm.retire).not.toHaveBeenCalled()
    expect(f.deps.commit).not.toHaveBeenCalled()
    expect((await f.coordinator.status()).swarm.phase).toBe('attention')
  })
  it('never turns a corrupt durable journal into empty state', async () => {
    const f = fixture(); await f.coordinator.initialize()
    await updateRuntimeJournal(() => {})
    // Force a new home/cache load, as a fresh process would.
    const home = process.env.OPENGROUND_HOME!
    process.env.OPENGROUND_HOME = `${home}-other`; await fixture().coordinator.initialize()
    process.env.OPENGROUND_HOME = home
    await writeFile(join(home, 'runtime', 'transitions.json'), '{broken')
    await expect(fixture().coordinator.initialize()).rejects.toThrow()
    expect(runtimeAdmissionBlocked('assistant')).toBe(true)
    expect(await readFile(join(home, 'runtime', 'transitions.json'), 'utf8')).toBe('{broken')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createSwarmRuntimeTransition, type SwarmTransitionActor, type SwarmTransitionDeps, type SwarmRuntimeCheckpoint } from './swarmRuntimeTransition'
const actor = (): SwarmTransitionActor => ({ id: 'old-president', runtime: 'sdk', role: 'supply',
  provider: 'claude', projectPath: '/synthetic/project', cwd: '/synthetic/project',
  transcript: [], pendingInputs: [], repository: { head: '', branch: '', status: '' } })
const rig = () => {
  const log: string[] = []
  let saved: SwarmRuntimeCheckpoint | undefined
  const deps: SwarmTransitionDeps = {
    engines: async () => { log.push('engine-settled'); return [] },
    actors: async () => [actor()],
    drain: async () => { log.push('actor-settled'); return { transcript: [{ kind: 'input', text: 'The owner goal' }], pendingInputs: [{ text: 'legacy queued' }, { text: 'ledger queued', operationId: 'root-owned' }] } },
    inspect: async () => { log.push('git-checkpoint'); return { head: 'saved-head', branch: 'main', status: ' M unfinished.txt' } },
    retire: async () => { log.push('recorded-actor-retired') },
    start: vi.fn(async () => { log.push('target-started'); return 'new-president' }),
    send: vi.fn(() => true),
    persist: async (checkpoint) => { saved = structuredClone(checkpoint) },
  }
  return { log, deps, transition: createSwarmRuntimeTransition(deps), latest: () => saved! }
}
describe('swarm provider handoff participant', () => {
  it('checkpoints settled work before retirement, transfers public context, and leaves ID-bound input with its durable owner', async () => {
    const f = rig(), checkpoint = await f.transition.drain()
    expect(f.log).toEqual(['engine-settled', 'actor-settled', 'git-checkpoint', 'engine-settled'])
    await f.transition.retire(checkpoint)
    await f.transition.resume({ provider: 'chatgpt', model: 'synthetic-plan-model' }, f.latest())
    expect(f.log).toEqual(['engine-settled', 'actor-settled', 'git-checkpoint', 'engine-settled', 'recorded-actor-retired', 'target-started'])
    expect(f.deps.start).toHaveBeenCalledWith(expect.objectContaining({ repository: { head: 'saved-head', branch: 'main', status: ' M unfinished.txt' } }),
      expect.objectContaining({ instructions: expect.stringContaining('The owner goal') }), undefined)
    expect(f.deps.send).toHaveBeenCalledExactlyOnceWith('new-president', 'legacy queued')
  })
  it('never retires or launches when the old action cannot settle', async () => {
    const f = rig()
    f.deps.drain = async () => { throw new Error('uncertain tool receipt') }
    await expect(f.transition.drain()).rejects.toThrow('uncertain')
    expect(f.log).not.toContain('recorded-actor-retired')
    expect(f.deps.start).not.toHaveBeenCalled()
  })
  it('attaches a proven target after partial launch and never restores its queued input twice', async () => {
    const f = rig(), checkpoint = await f.transition.drain()
    await f.transition.retire(checkpoint)
    f.deps.start = vi.fn(async () => { throw new Error('launch returned after the caller lost its reply') })
    f.deps.find = vi.fn(async () => 'proven-target')
    await expect(f.transition.resume({ provider: 'chatgpt' }, f.latest())).rejects.toThrow('lost its reply')
    expect(f.latest().actors[0].launch?.phase).toBe('starting')
    await f.transition.resume({ provider: 'chatgpt' }, f.latest())
    await f.transition.resume({ provider: 'chatgpt' }, f.latest())
    expect(f.deps.start).toHaveBeenCalledOnce()
    expect(f.deps.find).toHaveBeenCalledTimes(2)
    expect(f.deps.send).toHaveBeenCalledExactlyOnceWith('proven-target', 'legacy queued')
    expect(f.latest().actors[0].launch?.phase).toBe('restored')
  })
  it('holds a planned-but-unproven launch and never turns retry into another actor', async () => {
    const f = rig(), checkpoint = await f.transition.drain()
    await f.transition.retire(checkpoint)
    f.deps.start = vi.fn(async () => { throw new Error('unknown launch result') })
    f.deps.find = vi.fn(async () => null)
    await expect(f.transition.resume({ provider: 'chatgpt' }, f.latest())).rejects.toThrow('unknown launch')
    await expect(f.transition.resume({ provider: 'chatgpt' }, f.latest())).rejects.toThrow('without a provable live replacement')
    expect(f.deps.start).toHaveBeenCalledOnce()
    expect(f.deps.send).not.toHaveBeenCalled()
  })
  it('refuses target admission until retirement is durable', async () => {
    const f = rig(), checkpoint = await f.transition.drain()
    await expect(f.transition.resume({ provider: 'chatgpt' }, checkpoint)).rejects.toThrow('durably retired')
    expect(f.deps.start).not.toHaveBeenCalled()
  })
  it('retries a missing SDK only while its first prompt was durably prevented from admission', async () => {
    const f = rig(), checkpoint = await f.transition.drain()
    await f.transition.retire(checkpoint)
    f.deps.supportsPausedStart = () => true
    f.deps.start = vi.fn().mockRejectedValueOnce(new Error('lost paused handle')).mockResolvedValueOnce('paused-replacement')
    f.deps.find = async () => null
    f.deps.safeBeforeInput = vi.fn(async () => true)
    const readyPhases: string[] = []
    f.deps.ready = async () => { readyPhases.push(f.latest().actors[0].launch!.phase) }
    await expect(f.transition.resume({ provider: 'chatgpt' }, f.latest())).rejects.toThrow('lost paused handle')
    expect(f.latest().actors[0].launch).toMatchObject({ phase: 'starting', pausedStart: true })
    await f.transition.resume({ provider: 'chatgpt' }, f.latest())
    expect(readyPhases).toEqual(['activating'])
    expect(f.deps.start).toHaveBeenCalledTimes(2)
    expect(vi.mocked(f.deps.start).mock.calls[0][1].operationId).toBe(vi.mocked(f.deps.start).mock.calls[1][1].operationId)
  })
  it('holds a lost activated target until an owner review, then re-reads work and starts a new conversation once', async () => {
    const f = rig(), checkpoint = await f.transition.drain(), profile = { provider: 'claude' as const }
    await f.transition.retire(checkpoint)
    f.deps.find = vi.fn(async () => null)
    f.deps.start = vi.fn().mockResolvedValue('new-president')
    f.deps.ready = vi.fn().mockRejectedValueOnce(new Error('unknown activation result')).mockResolvedValue(undefined)
    await expect(f.transition.resume(profile, f.latest())).rejects.toThrow('unknown activation')
    const lost = f.latest(), id = lost.actors[0].launch!.operationId
    expect(lost.actors[0].launch?.phase).toBe('activating')
    expect(await f.transition.issues(profile, lost)).toEqual([{ id, actorOperationId: id, revision: lost.revision, role: 'supply' }])
    await expect(f.transition.resume(profile, lost)).rejects.toThrow('without a provable live replacement')
    await expect(f.transition.review(profile, lost, 'not-this-actor', 'checked work')).rejects.toThrow('no longer needs')
    await expect(f.transition.review(profile, lost, id, ' ')).rejects.toThrow()
    await f.transition.review(profile, lost, id, 'Owner inspected Git and the resulting files.')
    await f.transition.review(profile, f.latest(), id, 'Owner inspected Git and the resulting files.')
    await expect(f.transition.review(profile, f.latest(), id, 'changed note')).rejects.toThrow('different note')
    f.deps.inspect = async () => ({ head: 'latest-reviewed-head', branch: 'main', status: '' })
    f.deps.reviewContext = async () => ({ confirmedReceipts: [{ id: 'known-action', state: 'delivered' }], pendingInputs: [] })
    await f.transition.resume(profile, f.latest())
    expect(f.deps.start).toHaveBeenCalledTimes(2)
    const handoff = vi.mocked(f.deps.start).mock.calls[1][1]
    expect(handoff.operationId).not.toBe(id)
    expect(handoff.instructions).toContain('Do not blindly replay old instructions')
    expect(handoff.instructions).toContain('latest-reviewed-head')
    expect(handoff.instructions).toContain('known-action')
    expect(f.latest().actors[0].launch?.reviewed).toEqual({ operationId: id, note: 'Owner inspected Git and the resulting files.' })
    await expect(f.transition.resume(profile, f.latest())).rejects.toThrow('without a provable live replacement')
    expect(f.deps.start).toHaveBeenCalledTimes(2)
  })
  it('does not silently forget a restored target that disappeared, and never restarts finished Board work', async () => {
    const f = rig(), checkpoint = await f.transition.drain()
    checkpoint.actors[0].role = 'worker'; checkpoint.actors[0].pendingInputs = []
    checkpoint.engines = [{ path: '/synthetic/project', workers: [{ worker: { worktree: '/synthetic/project', taskId: 'done-card' }, budget: {} }] } as SwarmRuntimeCheckpoint['engines'][number]]
    await f.transition.retire(checkpoint)
    await f.transition.resume({ provider: 'chatgpt' }, f.latest())
    f.deps.find = async () => null
    await expect(f.transition.resume({ provider: 'chatgpt' }, f.latest())).rejects.toThrow('without a provable live replacement')
    f.deps.workStillNeeded = async () => false
    expect(await f.transition.issues({ provider: 'chatgpt' }, f.latest())).toEqual([])
    await f.transition.resume({ provider: 'chatgpt' }, f.latest())
    expect(f.latest().actors[0].launch?.phase).toBe('finished')
    expect(f.deps.start).toHaveBeenCalledOnce()
  })
  it('restores a retired missing intent from a reverse seed without replaying already consumed handoff inputs', async () => {
    const original = rig(), seed = await original.transition.drain()
    await original.transition.retire(seed)
    const f = rig()
    f.deps.actors = async () => []
    f.deps.recoverIntent = vi.fn(async (actor: SwarmTransitionActor) => ({ transcript: actor.transcript, pendingInputs: actor.pendingInputs.filter(input => input.operationId) }))
    const reversed = await f.transition.drain(undefined, original.latest())
    expect(reversed.actors).toHaveLength(1)
    expect(reversed.actors[0]).toMatchObject({ id: 'old-president', retired: true, pendingInputs: [{ text: 'ledger queued', operationId: 'root-owned' }] })
    expect(reversed.actors[0].launch?.operationId).not.toBe(original.latest().actors[0].launch?.operationId)
    await f.transition.retire(reversed)
    await f.transition.resume({ provider: 'claude' }, reversed)
    expect(f.deps.start).toHaveBeenCalledOnce(); expect(f.deps.send).not.toHaveBeenCalled()
  })
  it('prefers the actual live actor and omits finished Board worker intents when reversing a partial switch', async () => {
    const original = rig(), seed = await original.transition.drain()
    seed.actors.push({ ...actor(), id: 'finished-worker', role: 'worker', cwd: '/synthetic/project/worktree' })
    const f = rig()
    f.deps.actors = async () => [{ ...actor(), id: 'actual-replacement', provider: 'chatgpt' }]
    f.deps.workStillNeeded = async actor => actor.role !== 'worker'
    f.deps.recoverIntent = vi.fn(async actor => ({ transcript: actor.transcript, pendingInputs: [] }))
    const reversed = await f.transition.drain(undefined, seed)
    expect(reversed.actors.map(actor => actor.id)).toEqual(['actual-replacement'])
    expect(f.deps.recoverIntent).not.toHaveBeenCalled()
  })
  it('holds a reverse seed whose missing target could have acted and has not been reviewed', async () => {
    const original = rig(), seed = await original.transition.drain(), f = rig()
    f.deps.actors = async () => []
    f.deps.recoverIntent = async () => { throw new Error('target launch needs an owner work review') }
    await expect(f.transition.drain(undefined, seed)).rejects.toThrow('owner work review')
    expect(f.deps.start).not.toHaveBeenCalled(); expect(f.deps.send).not.toHaveBeenCalled()
  })
})

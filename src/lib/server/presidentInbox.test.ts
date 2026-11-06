// Real durable receipts + SDK pool; the query is a parked in-memory iterator.
// Native writes/proofs are explicit seams. No CLI, model, relay or user data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { registerTestProject } from '../../test/registerProject'
import { openGroundHome } from './paths'
import { acceptPresidentInput, awaitPresidentInputSettlement, cancelQueuedPresidentInputs, flushPresidentInbox, presidentInputReceipt, releaseRetiredPresidentInputs } from './presidentInbox'
import { readConversationReceipt, listConversationReceipts } from './conversationReceipts'
import { drainSdkSession, getSdkSession, removeSdkSession, spawnSdkSession, terminateSdkSession, type SdkQueryParams } from './sdkSession'
import * as atomic from './atomicWrite'

type NativeQueued = { path: string; line: string; done: (heard: boolean) => void; beforeSend?: () => Promise<void> }
type NativeDesk = { runtime: 'pty'; handleId: string; cwd: string; agentSessionId: string; lastOutputAt: null; startedAt: number; stopping: boolean }
const h = vi.hoisted(() => ({ owner: 'owner-a', blocked: true, native: null as NativeDesk | null,
  queued: [] as NativeQueued[], writes: [] as string[], cancelled: vi.fn(), offset: vi.fn(), proof: vi.fn() }))
vi.mock('./runtimeOwner', async original => ({ ...(await original<typeof import('./runtimeOwner')>()), runtimeOwnerKey: async (expected?: string) => {
  if (!h.owner || expected && expected !== h.owner) throw new Error('synthetic owner changed')
  return h.owner
} }))
vi.mock('./runtimeTransitionStore', async original => ({ ...await original<typeof import('./runtimeTransitionStore')>(), runtimeAdmissionBlocked: () => h.blocked }))
vi.mock('./swarmSupplyRuntime', async original => {
  const actual = await original<typeof import('./swarmSupplyRuntime')>()
  return { ...actual, listLiveSupplyDesks: (path: string) => h.native?.cwd === path ? [h.native] : actual.listLiveSupplyDesks(path) }
})
vi.mock('./terminal', async original => ({ ...await original<typeof import('./terminal')>(), listOwnerDeskTerminals: () => [], listLiveDesksIn: () => [] }))
vi.mock('./swarmRuntimeTransition', () => ({ nativePresidentTranscriptOffset: h.offset, waitForNativePresidentTurnSettled: h.proof }))
vi.mock('./supplyNotice', async original => ({ ...await original<typeof import('./supplyNotice')>(),
  queueSupplyOwnerSay: async (path: string, line: string, done: NativeQueued['done'], _deps: unknown, metadata: Pick<NativeQueued, 'beforeSend'>) => {
    h.queued.push({ path, line, done, ...metadata }); return h.queued.length
  },
  cancelSupplyOwnerSay: (path: string, done: NativeQueued['done']) => {
    h.cancelled(path, done)
    const index = h.queued.findIndex(item => item.path === path && item.done === done)
    if (index < 0) return false
    h.queued.splice(index, 1); return true
  },
}))
const sessions: string[] = []
const releases: (() => void)[] = []
let cwd: string, scope: string
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(async () => {
  h.owner = 'owner-a'; h.blocked = true; h.native = null; h.queued = []; h.writes = []; h.cancelled.mockClear()
  h.offset.mockReset().mockResolvedValue(128)
  h.proof.mockReset().mockResolvedValue({ agentSessionId: 'native-conversation', transcriptOffset: 256 })
  releaseRetiredPresidentInputs()
  await rm(join(openGroundHome(), 'runtime'), { recursive: true, force: true })
  cwd = await mkdtemp(join(openGroundHome(), 'president-inbox-project-')); scope = await registerTestProject(cwd)
})
afterEach(async () => {
  vi.restoreAllMocks(); h.owner = 'owner-a'; h.blocked = true
  for (const release of releases.splice(0)) release()
  await awaitPresidentInputSettlement().catch(() => {})
  await flushPresidentInbox().catch(() => {}) // retry saved result only; admission remains blocked
  releaseRetiredPresidentInputs()
  for (const id of sessions.splice(0)) {
    terminateSdkSession(id)
    await vi.waitFor(() => expect(getSdkSession(id)?.reaped).toBe(true))
    removeSdkSession(id)
  }
})
const rig = () => {
  let params!: SdkQueryParams
  let failure: Error | undefined
  const stopped = deferred<void>()
  const session = spawnSdkSession({ cwd, role: 'supply', provider: 'chatgpt', agentSessionId: `chatgpt-${randomUUID()}`,
    options: { runtimeOwnerKey: 'owner-a' }, distillMessage: () => [], queryFn: input => {
      params = input
      return { async *[Symbol.asyncIterator]() { await stopped.promise; if (failure) throw failure; yield* [] }, interrupt: async () => { stopped.resolve() } }
    } })
  sessions.push(session.id)
  return { session, input: params.prompt[Symbol.asyncIterator](), settled: () => params.onTurnSettled!(), interrupted: (safe: boolean) => params.onTurnInterrupted!(safe),
    end: (error?: Error) => { failure = error; stopped.resolve() } }
}
const native = () => { h.native = { runtime: 'pty', handleId: 'native-handle', cwd, agentSessionId: 'native-conversation', lastOutputAt: null, startedAt: 1, stopping: false } }
const flush = async () => { h.blocked = false; await flushPresidentInbox() }
const receipt = (id: string) => readConversationReceipt(scope, id, 'owner-a')
const sendNative = async (queued = h.queued[0], heard = true) => {
  if (!h.queued.includes(queued)) return
  await queued.beforeSend?.()
  if (!h.queued.includes(queued)) return
  h.writes.push(queued.line); h.queued.splice(h.queued.indexOf(queued), 1); queued.done(heard)
}

describe('durable president inbox through the SDK pool', () => {
  it('saves acceptance before actor consumption, then saves consumption and settlement at their distinct boundaries', async () => {
    const f = rig()
    const accepted = await acceptPresidentInput(cwd, 'owner words', { id: 'sdk-one', expectedOwnerKey: 'owner-a' })
    expect(accepted.receipt.state).toBe('queued')
    expect(getSdkSession(f.session.id)?.inputs ?? 0).toBe(0)
    expect(JSON.parse(await readFile(join(openGroundHome(), 'runtime', 'receipts.json'), 'utf8')).receipts).toBeTruthy()
    await flush()
    expect((await receipt('sdk-one'))?.state).toBe('queued')
    expect((await f.input.next()).value).toMatchObject({ message: { content: [{ text: 'owner words' }] } })
    expect((await receipt('sdk-one'))).toMatchObject({ state: 'executing', execution: { runtime: 'sdk', handleId: f.session.id } })
    await f.settled()
    expect((await presidentInputReceipt(scope, 'sdk-one', 'owner-a'))?.state).toBe('delivered')
    await awaitPresidentInputSettlement()
  })
  it('deduplicates the same ID and body, and refuses another body without another provider input', async () => {
    const f = rig()
    await acceptPresidentInput(cwd, 'same words', { id: 'sdk-duplicate' })
    await acceptPresidentInput(cwd, 'same words', { id: 'sdk-duplicate' })
    await expect(acceptPresidentInput(cwd, 'different words', { id: 'sdk-duplicate' })).rejects.toThrow('different content')
    await flush(); await flush(); await f.input.next(); await f.settled(); await flush()
    expect(getSdkSession(f.session.id)?.inputs).toBe(1)
    expect(await listConversationReceipts()).toHaveLength(1)
  })
  it('does not yield bytes to the provider when the fsynced execution claim fails', async () => {
    const f = rig()
    await acceptPresidentInput(cwd, 'never received', { id: 'sdk-claim-fail' }); await flush()
    vi.spyOn(atomic, 'atomicWriteJson').mockRejectedValueOnce(new Error('synthetic claim fsync failure'))
    await expect(f.input.next()).rejects.toThrow('claim fsync failure')
    expect(getSdkSession(f.session.id)?.inputs ?? 0).toBe(0)
    expect((await receipt('sdk-claim-fail'))?.state).toBe('queued')
  })
  it('retains an unconsumed ID across actor retirement and requeues it exactly once to the replacement', async () => {
    const old = rig()
    await acceptPresidentInput(cwd, 'after switching', { id: 'handoff-input' }); await flush()
    h.blocked = true
    const checkpoint = await drainSdkSession(old.session.id)
    expect(checkpoint.pendingInputs).toEqual([{ text: 'after switching', operationId: 'handoff-input' }])
    terminateSdkSession(old.session.id)
    await vi.waitFor(() => expect(getSdkSession(old.session.id)?.reaped).toBe(true))
    releaseRetiredPresidentInputs()
    const replacement = rig(); await flush(); await flush()
    expect((await old.input.next()).done).toBe(true)
    expect((await replacement.input.next()).value).toMatchObject({ message: { content: [{ text: 'after switching' }] } })
    await replacement.settled(); await flush()
    expect(getSdkSession(replacement.session.id)?.inputs).toBe(1)
    expect((await receipt('handoff-input'))?.state).toBe('delivered')
  })
  it('releases an unconsumed reservation when its actor ends naturally, without a provider transition', async () => {
    const old = rig()
    await acceptPresidentInput(cwd, 'still waiting for the president', { id: 'natural-retirement-input' }); await flush()
    old.end()
    await vi.waitFor(() => expect(getSdkSession(old.session.id)?.reaped).toBe(true))
    expect((await receipt('natural-retirement-input'))?.state).toBe('queued')
    const replacement = rig(); await flush(); await flush()
    const pending = await drainSdkSession(replacement.session.id)
    expect(pending.pendingInputs).toEqual([{ text: 'still waiting for the president', operationId: 'natural-retirement-input' }])
    // A drain pauses consumption; resume it only for the explicit fixture read.
    const { resumeSdkInputAdmission } = await import('./sdkSession')
    resumeSdkInputAdmission(replacement.session.id)
    expect((await replacement.input.next()).value).toMatchObject({ message: { content: [{ text: 'still waiting for the president' }] } })
    await replacement.settled()
    expect(getSdkSession(replacement.session.id)?.inputs).toBe(1)
    expect((await receipt('natural-retirement-input'))?.state).toBe('delivered')
  })
  it('persists a consumed fatal turn as uncertain before its original actor is reaped and never replays it', async () => {
    const old = rig()
    await acceptPresidentInput(cwd, 'possibly changed external work', { id: 'fatal-consumed-input' }); await flush(); await old.input.next()
    old.end(new Error('synthetic provider transport failed'))
    await vi.waitFor(() => expect(getSdkSession(old.session.id)?.reaped).toBe(true))
    expect((await receipt('fatal-consumed-input'))?.state).toBe('uncertain')
    const replacement = rig(); await flush()
    expect((await drainSdkSession(replacement.session.id)).pendingInputs).toEqual([])
    expect(getSdkSession(old.session.id)?.inputs).toBe(1)
  })
  it('holds retirement when fatal-turn settlement cannot be fsynced and retries only the receipt after disk recovery', async () => {
    const old = rig()
    await acceptPresidentInput(cwd, 'effect must not be replayed', { id: 'fatal-settlement-disk' }); await flush(); await old.input.next()
    const write = atomic.atomicWriteJson
    let diskFailed = true
    vi.spyOn(atomic, 'atomicWriteJson').mockImplementation(async (path, value, options) => {
      const saved = value as { receipts?: Record<string, { id: string; state: string }> }
      if (diskFailed && Object.values(saved.receipts ?? {}).some(item => item.id === 'fatal-settlement-disk' && item.state === 'uncertain')) throw new Error('synthetic receipt fsync unavailable')
      return write(path, value, options)
    })
    try {
      old.end(new Error('synthetic fatal stream'))
      await vi.waitFor(() => expect(getSdkSession(old.session.id)?.status).toBe('failed'))
      expect(getSdkSession(old.session.id)?.reaped).not.toBe(true)
      expect(getSdkSession(old.session.id)?.closed).toBe(true)
      expect((await receipt('fatal-settlement-disk'))?.state).toBe('executing')
      expect(getSdkSession(old.session.id)?.inputs).toBe(1)
      diskFailed = false
      await vi.waitFor(() => expect(getSdkSession(old.session.id)?.reaped).toBe(true))
      expect((await receipt('fatal-settlement-disk'))?.state).toBe('uncertain')
      expect(getSdkSession(old.session.id)?.inputs).toBe(1)
    } finally { diskFailed = false }
  })
  it('cancels an old epoch before the queued SDK input can reach its actor', async () => {
    const f = rig()
    const first = await acceptPresidentInput(cwd, 'old epoch', { id: 'sdk-old-epoch' }); await flush()
    await cancelQueuedPresidentInputs(cwd)
    expect((await receipt('sdk-old-epoch'))?.state).toBe('cancelled')
    await expect(acceptPresidentInput(cwd, 'stale epoch', { id: 'new-with-stale-epoch', conversationId: first.receipt.conversationId, epoch: first.receipt.epoch })).rejects.toThrow('different content')
    const nextInput = f.input.next()
    await vi.waitFor(() => expect(getSdkSession(f.session.id)?.status).toBe('waiting'))
    expect(getSdkSession(f.session.id)?.inputs ?? 0).toBe(0)
    await acceptPresidentInput(cwd, 'innocent next instruction', { id: 'after-cancelled-epoch' }); await flush()
    expect((await nextInput).value).toMatchObject({ message: { content: [{ text: 'innocent next instruction' }] } })
    expect(getSdkSession(f.session.id)?.inputs).toBe(1)
    expect(getSdkSession(f.session.id)?.closed).not.toBe(true)
    await f.settled()
    expect((await receipt('after-cancelled-epoch'))?.state).toBe('delivered')
  })
  it('holds an interrupted SDK effect with unknown outcome and does not automatically resend it', async () => {
    const f = rig()
    await acceptPresidentInput(cwd, 'unknown effect', { id: 'sdk-unknown' }); await flush(); await f.input.next()
    await f.interrupted(false)
    expect((await receipt('sdk-unknown'))?.state).toBe('uncertain')
    await expect(awaitPresidentInputSettlement()).rejects.toThrow('unconfirmed result')
    await flush()
    expect(getSdkSession(f.session.id)?.inputs).toBe(1)
  })
  it('does not commit an old owner callback into a replacement owner namespace', async () => {
    const f = rig()
    await acceptPresidentInput(cwd, 'old owner', { id: 'sdk-owner-late' }); await flush(); await f.input.next()
    h.owner = 'owner-b'
    await expect(f.settled()).rejects.toThrow('owner changed')
    expect(await listConversationReceipts()).toEqual([])
    h.owner = 'owner-a'
    expect((await receipt('sdk-owner-late'))?.state).toBe('executing')
    await f.interrupted(false)
    expect((await receipt('sdk-owner-late'))?.state).toBe('uncertain')
  })
  it('does not re-enqueue a previously consumed instruction after crash recovery under a new actor', async () => {
    const old = rig()
    await acceptPresidentInput(cwd, 'consumed before crash', { id: 'sdk-crash' }); await flush(); await old.input.next()
    terminateSdkSession(old.session.id)
    await vi.waitFor(() => expect(getSdkSession(old.session.id)?.reaped).toBe(true))
    const file = join(openGroundHome(), 'runtime', 'receipts.json')
    const disk = JSON.parse(await readFile(file, 'utf8')) as { receipts: Record<string, { attemptBoot?: string }> }
    Object.values(disk.receipts).forEach(item => { item.attemptBoot = 'previous-process-boot' })
    await writeFile(file, JSON.stringify(disk))
    releaseRetiredPresidentInputs()
    const replacement = rig(); await flush()
    expect((await receipt('sdk-crash'))?.state).toBe('uncertain')
    expect(getSdkSession(replacement.session.id)?.inputs ?? 0).toBe(0)
    expect((await drainSdkSession(replacement.session.id)).pendingInputs).toEqual([])
  })
})

describe('native president submission and proof boundary', () => {
  it('rejects a native line beyond its real terminal limit without a model or alternate transport fallback', async () => {
    native()
    await acceptPresidentInput(cwd, 'x'.repeat(1000), { id: 'native-too-long' }); await flush()
    expect((await receipt('native-too-long'))).toMatchObject({ state: 'rejected', result: { reason: 'too-long' } })
    expect(h.queued).toEqual([]); expect(h.writes).toEqual([])
  })
  it('writes only after its metadata claim and keeps heard as executing until the native reply is proven', async () => {
    native()
    const proof = deferred<{ agentSessionId: string; transcriptOffset: number }>(); releases.push(() => proof.resolve({ agentSessionId: 'native-conversation', transcriptOffset: 512 }))
    h.proof.mockReturnValueOnce(proof.promise)
    await acceptPresidentInput(cwd, 'native words', { id: 'native-one' }); await flush()
    expect(h.writes).toEqual([]); expect((await receipt('native-one'))?.state).toBe('queued')
    await sendNative()
    await vi.waitFor(async () => expect((await receipt('native-one'))?.result).toEqual({ heard: true }))
    expect((await receipt('native-one'))).toMatchObject({ state: 'executing', execution: { runtime: 'pty', nativeOffset: 128 } })
    expect(h.writes).toEqual(['native words'])
    proof.resolve({ agentSessionId: 'native-conversation', transcriptOffset: 512 }); await awaitPresidentInputSettlement()
    expect((await receipt('native-one'))).toMatchObject({ state: 'delivered', result: { heard: true, settled: true, transcriptOffset: 512 } })
  })
  it('allows only one native outstanding instruction and admits the next one after the first proof', async () => {
    native()
    const proof = deferred<{ agentSessionId: string; transcriptOffset: number }>(); releases.push(() => proof.resolve({ agentSessionId: 'native-conversation', transcriptOffset: 512 }))
    h.proof.mockReturnValueOnce(proof.promise)
    await acceptPresidentInput(cwd, 'first', { id: 'native-first' }); await acceptPresidentInput(cwd, 'second', { id: 'native-second' }); await flush()
    const second = h.queued[1]
    await sendNative(h.queued[0])
    await expect(sendNative(second)).rejects.toThrow('already answering')
    expect(h.writes).toEqual(['first'])
    proof.resolve({ agentSessionId: 'native-conversation', transcriptOffset: 512 }); await awaitPresidentInputSettlement()
    await sendNative(second); await awaitPresidentInputSettlement()
    expect(h.writes).toEqual(['first', 'second'])
  })
  it('cancels the old native callback before re-enqueueing the durable input after retirement', async () => {
    native()
    await acceptPresidentInput(cwd, 'one retained line', { id: 'native-retained' }); await flush()
    const old = h.queued[0]
    releaseRetiredPresidentInputs()
    expect(h.cancelled).toHaveBeenCalledWith(cwd, old.done)
    expect(h.queued).toEqual([])
    await flush(); expect(h.queued).toHaveLength(1)
    await sendNative(old); expect(h.writes).toEqual([])
    await sendNative(h.queued[0]); await awaitPresidentInputSettlement()
    expect(h.writes).toEqual(['one retained line'])
  })
  it('refuses a native write when owner identity changed after acceptance', async () => {
    native()
    await acceptPresidentInput(cwd, 'private owner line', { id: 'native-owner' }); await flush()
    h.owner = 'owner-b'
    await expect(sendNative()).rejects.toThrow('owner changed')
    expect(h.writes).toEqual([])
    h.owner = 'owner-a'
    expect((await receipt('native-owner'))?.state).toBe('queued')
  })
  it('does not write when its native execution claim cannot be persisted', async () => {
    native()
    await acceptPresidentInput(cwd, 'do not paste', { id: 'native-write-fail' }); await flush()
    vi.spyOn(atomic, 'atomicWriteJson').mockRejectedValueOnce(new Error('synthetic native claim fsync failure'))
    await expect(sendNative()).rejects.toThrow('native claim fsync failure')
    expect(h.writes).toEqual([])
    expect((await receipt('native-write-fail'))?.state).toBe('queued')
  })
  it('holds an unproven native turn instead of calling Enter acknowledgement a completed reply', async () => {
    native(); h.proof.mockRejectedValueOnce(new Error('synthetic native transcript proof missing'))
    await acceptPresidentInput(cwd, 'unknown native result', { id: 'native-unknown' }); await flush(); await sendNative()
    await vi.waitFor(async () => expect((await receipt('native-unknown'))?.state).toBe('uncertain'))
    await expect(awaitPresidentInputSettlement()).rejects.toThrow('unconfirmed result')
    await acceptPresidentInput(cwd, 'must remain queued', { id: 'after-unknown' }); await flush()
    expect(h.queued).toEqual([])
    expect((await receipt('after-unknown'))?.state).toBe('queued')
    expect(h.writes).toEqual(['unknown native result'])
  })
  it('blocks another native instruction while saving the previous native result remains unavailable, then saves proof without replay', async () => {
    native()
    const proof = deferred<{ agentSessionId: string; transcriptOffset: number }>(); releases.push(() => proof.resolve({ agentSessionId: 'native-conversation', transcriptOffset: 512 }))
    h.proof.mockReturnValueOnce(proof.promise)
    await acceptPresidentInput(cwd, 'first unknown', { id: 'native-post-save-fail' }); await flush(); await sendNative()
    await vi.waitFor(async () => expect((await receipt('native-post-save-fail'))?.result).toEqual({ heard: true }))
    const write = atomic.atomicWriteJson
    const unavailable = vi.spyOn(atomic, 'atomicWriteJson').mockImplementation(async (path, value, options) => {
      const saved = value as { receipts?: Record<string, { id: string; state: string }> }
      if (Object.values(saved.receipts ?? {}).some(item => item.id === 'native-post-save-fail' && item.state !== 'executing')) throw new Error('synthetic native final fsync unavailable')
      return write(path, value, options)
    })
    proof.resolve({ agentSessionId: 'native-conversation', transcriptOffset: 512 })
    await expect(awaitPresidentInputSettlement()).rejects.toThrow()
    expect((await receipt('native-post-save-fail'))?.state).toBe('executing')
    await acceptPresidentInput(cwd, 'must stay in durable inbox', { id: 'after-native-save-fail' }); await flush()
    // Staging is harmless only if the final beforeSend guard refuses bytes.
    if (h.queued.length) await expect(sendNative(h.queued[0])).rejects.toThrow()
    expect((await receipt('after-native-save-fail'))?.state).toBe('queued')
    expect(h.writes).toEqual(['first unknown'])
    unavailable.mockRestore()
    await flush()
    expect((await receipt('native-post-save-fail'))).toMatchObject({ state: 'delivered', result: { settled: true } })
    await sendNative(); await awaitPresidentInputSettlement()
    expect(h.writes).toEqual(['first unknown', 'must stay in durable inbox'])
  })
})

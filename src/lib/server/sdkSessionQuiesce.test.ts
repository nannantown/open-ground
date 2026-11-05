import { afterEach, describe, expect, it, vi } from 'vitest'
import { drainSdkSession, getSdkSession, pushSdkInput, spawnSdkSession, terminateSdkSession, interruptSdkSession, resumeSdkInputAdmission, sdkInputAdmissionPaused, readSdkFrames, currentSdkTurnId, currentSdkInputOperationId, type SdkQueryParams } from './sdkSession'
const ids: string[] = []
const rig = (initialPrompt?: string, startPaused = false, handoffTranscript?: { kind: 'input' | 'text'; text: string }[]) => {
  let params!: SdkQueryParams
  let stop = () => {}
  const stopped = new Promise<void>((resolve) => { stop = resolve })
  const session = spawnSdkSession({ cwd: '/synthetic-worktree', role: 'worker', provider: 'chatgpt', initialPrompt, startPaused, handoffTranscript,
    options: {}, distillMessage: () => [], queryFn: (input) => {
      params = input
      return { async *[Symbol.asyncIterator]() { await stopped; yield* [] }, interrupt: async () => { stop() } }
    } })
  ids.push(session.id)
  return { session, input: params.prompt[Symbol.asyncIterator](), settled: () => params.onTurnSettled!(), interrupted: (safe: boolean) => params.onTurnInterrupted!(safe), refused: () => params.onTurnRefused!() }
}
afterEach(async () => {
  for (const id of ids.splice(0)) { terminateSdkSession(id); await vi.waitFor(() => expect(getSdkSession(id)?.reaped).toBe(true)) }
})
describe('SDK durable input boundary', () => {
  it('prevents eager provider prefetch and preserves the queued input at a drain boundary', async () => {
    const f = rig('first')
    expect((await f.input.next()).done).toBe(false)
    let prefetched = false
    const next = f.input.next().then((value) => { prefetched = true; return value })
    expect(pushSdkInput(f.session.id, 'second')).toBe(true)
    await Promise.resolve()
    expect(prefetched).toBe(false)
    const drained = drainSdkSession(f.session.id)
    expect(pushSdkInput(f.session.id, 'late')).toBe(false)
    await f.settled()
    expect(await drained).toMatchObject({ settledInputs: 1, pendingInputs: [{ text: 'second' }] })
    expect(prefetched).toBe(false)
    terminateSdkSession(f.session.id)
    expect((await next).done).toBe(true)
  })
  it('persists consumption before provider input and settlement before drain completes', async () => {
    const f = rig()
    let consume = () => {}, complete = () => {}
    const consumption = new Promise<void>((resolve) => { consume = resolve })
    const completion = new Promise<void>((resolve) => { complete = resolve })
    const onConsumed = vi.fn(() => consumption), onSettled = vi.fn(() => completion)
    expect(pushSdkInput(f.session.id, 'owner words', { operationId: 'stable-op', onConsumed, onSettled })).toBe(true)
    let received = false
    const input = f.input.next().then((value) => { received = true; return value })
    expect(onConsumed).toHaveBeenCalledOnce()
    expect(received).toBe(false)
    consume(); await input
    expect(pushSdkInput(f.session.id, 'owner words', { operationId: 'stable-op' })).toBe(true)
    expect(pushSdkInput(f.session.id, 'different body', { operationId: 'stable-op' })).toBe(false)
    let drained = false
    const drain = drainSdkSession(f.session.id).then(() => { drained = true })
    const settle = f.settled()
    expect(onSettled).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(drained).toBe(false)
    complete(); await settle; await drain
    expect(drained).toBe(true)
    expect(getSdkSession(f.session.id)?.inputs).toBe(1)
  })
  it('releases a safe cancellation without falsely delivering the accepted message', async () => {
    const f = rig(), onSettled = vi.fn(async () => {}), onInterrupted = vi.fn(async () => {})
    pushSdkInput(f.session.id, 'cancel me', { operationId: 'cancelled-op', onSettled, onInterrupted })
    await f.input.next()
    await f.interrupted(true)
    expect(onInterrupted).toHaveBeenCalledOnce()
    expect(onInterrupted).toHaveBeenCalledWith(true)
    expect(onSettled).not.toHaveBeenCalled()
    expect((await drainSdkSession(f.session.id)).settledInputs).toBe(1)
  })
  it('keeps an interruption with unknown host effects outside the resumable boundary', async () => {
    const f = rig('uncertain action')
    await f.input.next()
    await f.interrupted(false)
    await expect(drainSdkSession(f.session.id, 0)).rejects.toThrow('durable turn boundary')
  })
  it('cancels an input still persisting its claim before it reaches the provider', async () => {
    const f = rig()
    let release = () => {}
    const claim = new Promise<void>((resolve) => { release = resolve })
    const cancelled = vi.fn(async () => {})
    pushSdkInput(f.session.id, 'must never reach the model', { onConsumed: () => claim, onInterrupted: cancelled })
    let reached = false
    const input = f.input.next().then((value) => { reached = !value.done; return value })
    expect(await interruptSdkSession(f.session.id)).toBe(true)
    release()
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledExactlyOnceWith(true))
    expect(reached).toBe(false)
    expect(getSdkSession(f.session.id)?.inputs ?? 0).toBe(0)
    terminateSdkSession(f.session.id)
    expect((await input).done).toBe(true)
  })
  it('cancels a drain without consuming its queue or losing the original actor', async () => {
    const f = rig('first')
    await f.input.next()
    pushSdkInput(f.session.id, 'second')
    const abort = new AbortController()
    const drain = drainSdkSession(f.session.id, 120_000, abort.signal)
    expect(sdkInputAdmissionPaused(f.session.id)).toBe(true)
    abort.abort()
    await expect(drain).rejects.toThrow('cancelled')
    resumeSdkInputAdmission(f.session.id)
    expect(sdkInputAdmissionPaused(f.session.id)).toBe(false)
    await f.settled()
    expect((await f.input.next()).value).toMatchObject({ message: { content: [{ text: 'second' }] } })
    await f.settled()
  })
  it('does not turn an unconsumed role startup prompt into a queued owner message', async () => {
    const f = rig('/supply')
    expect((await drainSdkSession(f.session.id)).pendingInputs).toEqual([])
  })
  it('does not admit even the startup prompt before the coordinator persists and activates its handle', async () => {
    const f = rig('initial role and goal', true)
    let received = false
    const first = f.input.next().then((value) => { received = !value.done; return value })
    await Promise.resolve()
    expect(received).toBe(false)
    expect(getSdkSession(f.session.id)?.inputs ?? 0).toBe(0)
    resumeSdkInputAdmission(f.session.id)
    expect((await first).value).toMatchObject({ message: { content: [{ text: 'initial role and goal' }] } })
    await f.settled()
  })
  it('makes a usage refusal durable without claiming fulfilment and retains the next queued message for a switch', async () => {
    const f = rig(), onRefused = vi.fn(async () => {}), onSettled = vi.fn(async () => {}), onInterrupted = vi.fn(async () => {})
    pushSdkInput(f.session.id, 'requested work', { operationId: 'limited-input', onRefused, onSettled, onInterrupted })
    await f.input.next()
    pushSdkInput(f.session.id, 'after switching', { operationId: 'still-queued' })
    await f.refused()
    expect(onRefused).toHaveBeenCalledOnce()
    expect(onSettled).not.toHaveBeenCalled(); expect(onInterrupted).not.toHaveBeenCalled()
    expect(sdkInputAdmissionPaused(f.session.id)).toBe(true)
    expect(await drainSdkSession(f.session.id)).toMatchObject({ settledInputs: 1, pendingInputs: [{ text: 'after switching', operationId: 'still-queued' }] })
  })
  it('preserves full owner words independently from the UI clamp and does not duplicate a seeded handoff inside the role prompt', async () => {
    const original = { kind: 'input' as const, text: 'Original confirmed owner words' }
    const f = rig('internal role prompt containing the old handoff', false, [original])
    await f.input.next(); await f.settled()
    const long = 'word '.repeat(1000)
    pushSdkInput(f.session.id, long)
    await f.input.next(); await f.settled()
    expect(readSdkFrames(f.session.id, 0, 100)?.frames.filter(({ ev }) => ev.kind === 'input').at(-1)?.ev).toMatchObject({ kind: 'input', text: expect.stringContaining('…') })
    expect((await drainSdkSession(f.session.id)).transcript).toEqual([original, { kind: 'input', text: long }])
  })
  it('holds an oversized public context visibly instead of handing off a silently truncated conversation', async () => {
    const f = rig()
    pushSdkInput(f.session.id, 'x'.repeat(256 * 1024))
    await f.input.next(); await f.settled()
    await expect(drainSdkSession(f.session.id)).rejects.toThrow('not silently truncated')
  })
  it('captures custom-provider text before settlement even when the UI event is drained later, without duplicating it', async () => {
    let saved: ReturnType<NonNullable<SdkQueryParams['publicConversation']>> | undefined
    const session = spawnSdkSession({ cwd: '/synthetic/project', provider: 'chatgpt', options: {},
      distillMessage: message => [message as import('./sdkEvents').SdkEvent], queryFn: params => ({
        async *[Symbol.asyncIterator]() {
          for await (const _input of params.prompt) {
            params.onPublicText!('The complete public answer')
            saved = params.publicConversation!()
            await params.onTurnSettled!()
            yield { kind: 'text', text: 'The complete public answer' }
            yield { kind: 'turn_end', reason: 'completed', isError: false }
          }
        }, interrupt: async () => {},
      }) })
    ids.push(session.id)
    pushSdkInput(session.id, 'owner input')
    await vi.waitFor(() => expect(getSdkSession(session.id)?.status).toBe('waiting'))
    expect(saved).toEqual({ lines: [{ kind: 'input', text: 'owner input' }, { kind: 'text', text: 'The complete public answer' }], overflow: false })
    expect((await drainSdkSession(session.id)).transcript).toEqual(saved!.lines)
  })
  it('binds a stop target to one SDK turn, including kickoff, and uses the durable receipt ID when available', async () => {
    const f = rig('role kickoff')
    await f.input.next()
    const kickoff = currentSdkTurnId(f.session.id)
    expect(kickoff).toMatch(/^sdk-turn-/)
    expect(currentSdkTurnId(f.session.id)).toBe(kickoff)
    expect(currentSdkInputOperationId(f.session.id)).toBeNull()
    await f.interrupted(true)
    expect(currentSdkTurnId(f.session.id)).toBeNull()
    pushSdkInput(f.session.id, 'accepted owner turn', { operationId: 'stable-owner-receipt' })
    await f.input.next()
    expect(currentSdkTurnId(f.session.id)).toBe('stable-owner-receipt')
    expect(currentSdkTurnId(f.session.id)).not.toBe(kickoff)
    await f.settled()
    expect(currentSdkTurnId(f.session.id)).toBeNull()
  })
})

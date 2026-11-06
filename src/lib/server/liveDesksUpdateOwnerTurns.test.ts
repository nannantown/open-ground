import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveTerminalsResponse, UpdateRestartSafetyResponse } from '../types'
import type { TerminalInfo } from './terminal'
import { decideAutoApply, AUTO_APPLY_MAX_DEFER_MS } from '../../../electron/autoUpdatePolicy'
const mocks = vi.hoisted(() => ({
  owner: vi.fn(async () => true),
  ownerKey: vi.fn(async () => 'test-owner'),
  terminals: vi.fn(() => [] as TerminalInfo[]),
  active: vi.fn((): ActiveTerminalsResponse => ({ cwds: [], claude: [] })),
}))
vi.mock('./terminal', () => ({
  listActiveTerminalCwds: () => [], listActiveTerminals: mocks.active,
  listPtySafetyViews: () => [], listOwnerDeskTerminals: mocks.terminals,
  killTerminalsByCwdAndWait: async () => true,
}))
vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: mocks.owner }))
vi.mock('./runtimeOwner', () => ({ runtimeOwnerKey: mocks.ownerKey, currentRuntimeOwnerKey: () => undefined }))
import { updateRestartSafety } from './liveDesks'
import { acceptConversationReceipt, claimConversationReceipt, finishConversationReceipt } from './conversationReceipts'
import { spawnSdkSession, terminateSdkSession, getSdkSession, type SdkQueryParams } from './sdkSession'

const ids: string[] = []
let nextId = 0
const scope = 'update-owner-project'
const accept = async (state: 'queued' | 'executing' | 'uncertain' = 'queued', execution?: { sessionId: string; handleId: string; runtime: 'sdk' | 'pty' }) => {
  const id = `input-${nextId++}`
  await acceptConversationReceipt(scope, id, { kind: 'president-input', path: '/synthetic-project', text: 'fixture instruction' })
  if (state !== 'queued') await claimConversationReceipt(scope, id, execution)
  if (state === 'uncertain') await finishConversationReceipt(scope, id, 'uncertain')
  return id
}
const rig = (role: 'supply' | 'manager' | 'worker' = 'supply') => {
  let params!: SdkQueryParams, stop = () => {}
  const stopped = new Promise<void>((resolve) => { stop = resolve })
  const session = spawnSdkSession({ cwd: '/synthetic-project', role, provider: 'chatgpt', options: {}, distillMessage: () => [],
    queryFn: (input) => { params = input; return { async *[Symbol.asyncIterator]() { await stopped; yield* [] }, interrupt: async () => { stop() } } } })
  ids.push(session.id)
  return { session, input: params.prompt[Symbol.asyncIterator](), settled: () => params.onTurnSettled!() }
}
beforeEach(() => { mocks.ownerKey.mockClear(); mocks.owner.mockResolvedValue(true); mocks.terminals.mockReturnValue([]); mocks.active.mockReturnValue({ cwds: [], claude: [] }) })
afterEach(async () => {
  for (const id of ids.splice(0)) { terminateSdkSession(id); await vi.waitFor(() => expect(getSdkSession(id)?.reaped).toBe(true)) }
})

describe('actual restart-safety probe protects owner president turns', () => {
  it('counts a consumed SDK president turn before status becomes working, until durable settlement', async () => {
    mocks.owner.mockResolvedValue(false)
    const f = rig()
    const { pushSdkInput } = await import('./sdkSession')
    pushSdkInput(f.session.id, 'one owner instruction')
    await f.input.next()
    const active = await updateRestartSafety()
    expect(active.activeOwnerTurns).toBe(1)
    const request = { enabled: true, lockdown: false, hasDownloaded: true, asap: true, inputIdleMs: 0, heldMs: AUTO_APPLY_MAX_DEFER_MS * 2 }
    expect(decideAutoApply({ ...request, safety: active }).apply).toBe(false)
    await f.settled()
    const complete = await updateRestartSafety()
    expect(complete.activeOwnerTurns).toBe(0)
    expect(decideAutoApply({ ...request, safety: complete }).apply).toBe(true)
    expect(mocks.ownerKey).not.toHaveBeenCalled()
  })
  it('does not hold for background manager and worker turns', async () => {
    mocks.owner.mockResolvedValue(false)
    const { pushSdkInput } = await import('./sdkSession')
    for (const role of ['manager', 'worker'] as const) { const f = rig(role); pushSdkInput(f.session.id, 'background'); await f.input.next() }
    expect(await updateRestartSafety()).toMatchObject({ activeOwnerTurns: 0, generating: 2 })
  })
  it('deduplicates executing durable owner input with its live SDK turn and releases only after settlement', async () => {
    const f = rig(), { pushSdkInput } = await import('./sdkSession')
    const id = await accept('executing', { sessionId: 'synthetic-session', handleId: f.session.id, runtime: 'sdk' })
    pushSdkInput(f.session.id, 'owner instruction', { operationId: id })
    await f.input.next()
    expect((await updateRestartSafety()).activeOwnerTurns).toBe(1)
    await finishConversationReceipt(scope, id, 'delivered')
    expect((await updateRestartSafety()).activeOwnerTurns).toBe(1)
    await f.settled()
    expect((await updateRestartSafety()).activeOwnerTurns).toBe(0)
  })
  it('does not indefinitely block on already queued or uncertain inputs', async () => {
    await accept('queued'); await accept('uncertain')
    expect((await updateRestartSafety()).activeOwnerTurns).toBe(0)
  })
  it('protects actual PTY president generation for a legacy local user, without counting a manager', async () => {
    mocks.owner.mockResolvedValue(false)
    mocks.terminals.mockReturnValue([{ id: 'president', deskLabel: '補給官' }, { id: 'manager', deskLabel: '司令官' }] as TerminalInfo[])
    mocks.active.mockReturnValue({ cwds: ['/synthetic-project'], claude: [
      { id: 'president', cwd: '/synthetic-project', status: 'working', desk: true },
      { id: 'manager', cwd: '/synthetic-project', status: 'working', desk: true },
    ] })
    expect((await updateRestartSafety()).activeOwnerTurns).toBe(1)
    mocks.active.mockReturnValue({ cwds: [], claude: [] })
    expect((await updateRestartSafety()).activeOwnerTurns).toBe(0)
  })
  it('ignores executing non-president receipts', async () => {
    const id = `other-${nextId++}`
    await acceptConversationReceipt(scope, id, { kind: 'assistant-input' })
    await claimConversationReceipt(scope, id)
    expect((await updateRestartSafety()).activeOwnerTurns).toBe(0)
    await finishConversationReceipt(scope, id, 'delivered')
  })
  it('covers the durable native send-to-prompt observation gap', async () => {
    const id = await accept('executing', { sessionId: 'native-session', handleId: 'native-president', runtime: 'pty' })
    expect((await updateRestartSafety()).activeOwnerTurns).toBe(1)
    await finishConversationReceipt(scope, id, 'delivered')
    expect((await updateRestartSafety()).activeOwnerTurns).toBe(0)
  })
})

// A producer omitting this required wire field is a compile-time error; an old
// deployed producer omitting it is separately rejected by the Electron policy.
// @ts-expect-error activeOwnerTurns is required on every complete probe response
const incompleteProbe: UpdateRestartSafetyResponse = { safe: true, generating: 0, userPtys: 0 }
void incompleteProbe

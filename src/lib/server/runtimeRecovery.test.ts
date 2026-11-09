import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runtimeRecoveryIssues } from './runtimeRecovery'
import type { ConversationReceipt } from './conversationReceipts'

const mock = vi.hoisted(() => ({
  eligible: true, owner: 'owner-a',
  ownerKey: vi.fn(), receipts: vi.fn(), finish: vi.fn(), connection: vi.fn(),
  actions: vi.fn(), agentOccupied: vi.fn(), handleOccupied: vi.fn(), settings: vi.fn(),
  knownFinal: vi.fn(), launches: vi.fn(), native: vi.fn(),
}))
vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: async () => mock.eligible }))
vi.mock('./runtimeOwner', () => ({ runtimeOwnerKey: mock.ownerKey }))
vi.mock('./conversationReceipts', () => ({ listConversationReceipts: mock.receipts, finishConversationReceipt: mock.finish }))
vi.mock('./chatgptAuth', () => ({ getChatGptConnection: mock.connection }))
vi.mock('./chatgptResponses', () => ({ listChatGptUncertainActions: mock.actions }))
vi.mock('./liveDesks', () => ({ isAgentConversationOccupied: mock.agentOccupied, isRecordedRuntimeHandleOccupied: mock.handleOccupied }))
vi.mock('./store', () => ({ getSettings: mock.settings }))
vi.mock('./presidentInbox', () => ({ presidentInputHasKnownFinal: mock.knownFinal }))
vi.mock('./swarmRuntimeTransition', () => ({ listSwarmLaunchRecoveryIssues: mock.launches, listNativeConversationRecoveryIssues: mock.native }))

const receipt = (patch: Partial<ConversationReceipt> = {}): ConversationReceipt => ({
  id: 'input-one', scope: 'project-one', owner: 'owner-a', hash: 'a'.repeat(64),
  body: { kind: 'president-input', sessionId: 'conversation-one', text: 'private instruction' },
  state: 'executing', acceptedAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z',
  execution: { runtime: 'sdk', sessionId: 'conversation-one', handleId: 'original-handle' }, ...patch,
})
beforeEach(() => {
  vi.resetAllMocks(); mock.eligible = true; mock.owner = 'owner-a'
  mock.ownerKey.mockImplementation(async (expected?: string) => {
    if (expected !== undefined && expected !== mock.owner) throw new Error('owner changed')
    return mock.owner
  })
  mock.receipts.mockResolvedValue([]); mock.connection.mockResolvedValue({ state: 'signed-out', models: [] })
  mock.actions.mockResolvedValue([]); mock.settings.mockResolvedValue({ lockdownMode: false })
  mock.agentOccupied.mockReturnValue(false); mock.handleOccupied.mockReturnValue(false)
  mock.knownFinal.mockReturnValue(false); mock.launches.mockResolvedValue([]); mock.native.mockResolvedValue([])
})

describe('runtime recovery uses the original actor handle and admitted owner', () => {
  it('identifies the registered project to inspect without exposing receipt bodies or tool arguments', async () => {
    mock.settings.mockResolvedValue({ projects: [{ id: 'project-one', path: '/synthetic/project', displayName: 'Owner project' }] })
    mock.receipts.mockResolvedValue([receipt({ state: 'uncertain' })])
    expect(await runtimeRecoveryIssues('owner-a')).toEqual([{ id: 'input-one', scope: 'project-one', kind: 'input', state: 'uncertain', projectName: 'Owner project', projectPath: '/synthetic/project' }])
  })
  it.each(['sdk', 'pty'] as const)('marks a dead original %s handle uncertain even when a replacement uses the same conversation ID', async (runtime) => {
    mock.receipts.mockResolvedValue([receipt({ execution: { runtime, sessionId: 'conversation-one', handleId: 'original-handle' } })])
    mock.agentOccupied.mockReturnValue(true)
    expect(await runtimeRecoveryIssues('owner-a')).toEqual([{ id: 'input-one', scope: 'project-one', kind: 'input', state: 'uncertain' }])
    expect(mock.handleOccupied).toHaveBeenCalledWith(runtime, 'original-handle')
    expect(mock.finish).toHaveBeenCalledExactlyOnceWith('project-one', 'input-one', 'uncertain', { reason: 'actor-ended-without-result', automaticReplay: false }, 'owner-a')
    expect(mock.agentOccupied).not.toHaveBeenCalled()
  })
  it('does not mistake a live original handle for a finished operation when its conversation lookup is missing', async () => {
    mock.receipts.mockResolvedValue([receipt()]); mock.handleOccupied.mockReturnValue(true)
    expect(await runtimeRecoveryIssues('owner-a')).toEqual([])
    expect(mock.finish).not.toHaveBeenCalled()
  })
  it.each(['executing', 'uncertain'] as const)('keeps an %s old tool effect visible when only a replacement handle occupies its conversation ID', async (state) => {
    mock.receipts.mockResolvedValue([receipt({ state, body: { kind: 'runtime-tool', sessionId: 'conversation-one', tool: 'Bash', arguments: 'private command' } })])
    mock.agentOccupied.mockReturnValue(true)
    expect(await runtimeRecoveryIssues('owner-a')).toEqual([{ id: 'input-one', scope: 'project-one', kind: 'tool', tool: 'Bash', state: 'uncertain' }])
    expect(mock.finish).toHaveBeenCalledTimes(state === 'executing' ? 1 : 0)
  })
  it('leaves a known native final alone so its durable completion can retry after the original actor exits', async () => {
    const original = receipt({ execution: { runtime: 'pty', sessionId: 'conversation-one', handleId: 'original-handle' } })
    mock.receipts.mockResolvedValue([original]); mock.knownFinal.mockReturnValue(true)
    expect(await runtimeRecoveryIssues('owner-a')).toEqual([])
    expect(original.state).toBe('executing')
    expect(mock.finish).not.toHaveBeenCalled()
    expect(mock.handleOccupied).not.toHaveBeenCalled()
  })
  it('does not refresh ChatGPT while in work mode and still exposes local native and launch recovery', async () => {
    mock.settings.mockResolvedValue({ lockdownMode: true })
    mock.connection.mockRejectedValue(new Error('must not refresh an account'))
    mock.launches.mockResolvedValue([{ id: 'launch-one' }])
    mock.native.mockResolvedValue([{ id: 'native-one', scope: 'project-one', kind: 'conversation', conversationId: 'native-conversation', state: 'uncertain' }])
    expect(await runtimeRecoveryIssues('owner-a')).toEqual([
      { id: 'launch-one', scope: 'swarm', kind: 'launch', state: 'uncertain' },
      { id: 'native-one', scope: 'project-one', kind: 'conversation', conversationId: 'native-conversation', state: 'uncertain' },
    ])
    expect(mock.connection).not.toHaveBeenCalled()
    expect(mock.actions).not.toHaveBeenCalled()
  })
  it('exposes only review metadata rather than private receipt payloads', async () => {
    mock.receipts.mockResolvedValue([receipt({ state: 'uncertain', body: { kind: 'runtime-tool', sessionId: 'ended', tool: 'Write', contents: 'private file' } })])
    const issues = await runtimeRecoveryIssues('owner-a')
    expect(issues).toEqual([{ id: 'input-one', scope: 'project-one', kind: 'tool', tool: 'Write', state: 'uncertain' }])
    expect(JSON.stringify(issues)).not.toMatch(/private|owner-a|original-handle|hash/)
  })
  it('refuses a stale owner before inspecting receipts', async () => {
    await expect(runtimeRecoveryIssues('owner-before')).rejects.toThrow('owner changed')
    expect(mock.receipts).not.toHaveBeenCalled()
  })
  it('rechecks the admitted owner after asynchronous inspection before returning any issues', async () => {
    mock.native.mockImplementation(async () => { mock.owner = 'owner-b'; return [] })
    await expect(runtimeRecoveryIssues('owner-a')).rejects.toThrow('owner changed')
    expect(mock.ownerKey).toHaveBeenLastCalledWith('owner-a')
  })
  it('does not inspect owner recovery for a local unlock or a signed-out user', async () => {
    mock.eligible = false
    expect(await runtimeRecoveryIssues()).toEqual([])
    expect(mock.ownerKey).not.toHaveBeenCalled()
    expect(mock.receipts).not.toHaveBeenCalled()
    expect(mock.connection).not.toHaveBeenCalled()
  })
})


it('keeps launch and healthy conversation issues beside an unavailable native history', async () => {
  const unavailable = { id: 'native-unavailable', scope: 'project-one', kind: 'conversation', conversationId: 'unavailable', state: 'uncertain', inspectionError: 'native-history-unavailable' }
  const healthy = { id: 'native-healthy', scope: 'project-two', kind: 'conversation', conversationId: 'healthy', tool: 'Bash', state: 'uncertain' }
  mock.launches.mockResolvedValue([{ id: 'launch-one' }]); mock.native.mockResolvedValue([unavailable, healthy])
  expect(await runtimeRecoveryIssues('owner-a')).toEqual([{ id: 'launch-one', scope: 'swarm', kind: 'launch', state: 'uncertain' }, unavailable, healthy])
})

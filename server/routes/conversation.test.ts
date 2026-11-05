import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  eligible: true, owner: 'owner-a', requestOwner: vi.fn(), ownerKey: vi.fn(),
  issues: vi.fn(), accept: vi.fn(), claim: vi.fn(), read: vi.fn(), review: vi.fn(), settle: vi.fn(),
  launch: vi.fn(), native: vi.fn(), chatgpt: vi.fn(), occupied: vi.fn(), notify: vi.fn(),
  draftRead: vi.fn(), draftSave: vi.fn(), presidentReceipt: vi.fn(), assistantReceipt: vi.fn(),
}))
vi.mock('@/lib/server/chatgptAccess', () => ({ hasChatGptAccess: async () => mock.eligible }))
vi.mock('@/lib/server/runtimeOwner', () => ({ runtimeRequestOwnerKey: mock.requestOwner, runtimeOwnerKey: mock.ownerKey }))
vi.mock('@/lib/server/runtimeRecovery', () => ({ runtimeRecoveryIssues: mock.issues }))
vi.mock('@/lib/server/conversationReceipts', () => ({ acceptConversationReceipt: mock.accept, claimConversationReceipt: mock.claim, readConversationReceipt: mock.read, reviewConversationReceipt: mock.review, settleRecoveryReviewReceipt: mock.settle }))
vi.mock('@/lib/server/swarmRuntimeTransition', () => ({ reviewSwarmLaunchRecovery: mock.launch, reviewNativeConversationRecovery: mock.native }))
vi.mock('@/lib/server/chatgptResponses', () => ({ reviewChatGptUncertainAction: mock.chatgpt }))
vi.mock('@/lib/server/liveDesks', () => ({ isAgentConversationOccupied: mock.occupied }))
vi.mock('@/lib/server/runtimeRecoveryBoot', () => ({ notifyRuntimeRecoveryChanged: mock.notify }))
vi.mock('@/lib/server/conversationDrafts', () => ({ readConversationDraft: mock.draftRead, saveConversationDraft: mock.draftSave, DraftConflict: class extends Error {} }))
vi.mock('@/lib/server/presidentInbox', () => ({ presidentInputReceipt: mock.presidentReceipt }))
vi.mock('@/lib/server/assistantRuntimeStore', () => ({ getAssistantTurnReceipt: mock.assistantReceipt }))

import { conversationRoutes } from './conversation'

const request = (body: object, headers: Record<string, string> = {}) => conversationRoutes.request('/api/conversation/recovery/review', {
  method: 'POST', headers: { 'content-type': 'application/json', 'X-OpenGround-Owner': 'renderer-owner-a', ...headers }, body: JSON.stringify(body),
})
const launchReview = { operationId: 'review-one', id: 'launch-one', scope: 'swarm', kind: 'launch', note: '実際のBoardとGitを確認済み。再実行しません。' }
beforeEach(() => {
  vi.resetAllMocks(); mock.eligible = true; mock.owner = 'owner-a'
  mock.requestOwner.mockImplementation(async (claimed?: string) => {
    if (claimed !== undefined && claimed !== `renderer-${mock.owner}`) throw new Error('owner changed')
    return mock.owner
  })
  mock.ownerKey.mockImplementation(async (expected?: string) => {
    if (expected !== undefined && expected !== mock.owner) throw new Error('owner changed')
    return mock.owner
  })
  mock.issues.mockResolvedValue([]); mock.accept.mockResolvedValue({ state: 'queued' }); mock.claim.mockResolvedValue(true)
  mock.notify.mockResolvedValue(undefined)
  for (const review of [mock.launch, mock.native]) review.mockImplementation(async (options: { expectedOwnerKey?: string }) => {
    if (options.expectedOwnerKey !== mock.owner) throw new Error('owner changed')
  })
})

describe('owner recovery review route wiring', () => {
  it('passes the immutable admitted owner through launch review and its durable completion', async () => {
    const response = await request(launchReview)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, issues: [] })
    expect(mock.requestOwner).toHaveBeenCalledExactlyOnceWith('renderer-owner-a')
    expect(mock.accept).toHaveBeenCalledWith('control-recovery', 'review-one', { ...launchReview, kind: 'recovery-review', reviewKind: 'launch' }, undefined, 'owner-a')
    expect(mock.claim).toHaveBeenCalledWith('control-recovery', 'review-one', undefined, 'owner-a')
    expect(mock.launch).toHaveBeenCalledExactlyOnceWith({ id: 'launch-one', note: launchReview.note, expectedOwnerKey: 'owner-a' })
    expect(mock.settle).toHaveBeenCalledWith('review-one', { ok: true, issues: [] }, 'owner-a')
    expect(mock.issues).toHaveBeenCalledWith('owner-a')
    expect(mock.notify).toHaveBeenCalledTimes(1)
    expect(mock.native).not.toHaveBeenCalled()
    expect(mock.chatgpt).not.toHaveBeenCalled()
  })
  it('dispatches native conversation review with project, session, stable operation ID and owner', async () => {
    const body = { operationId: 'native-review', id: 'native-one', scope: 'project-one', kind: 'conversation', conversationId: 'native-session', note: '作業結果を確認済みです。' }
    const response = await request(body)
    expect(response.status).toBe(200)
    expect(mock.native).toHaveBeenCalledExactlyOnceWith({ id: 'native-one', projectId: 'project-one', sessionId: 'native-session', note: body.note, operationId: 'native-review', expectedOwnerKey: 'owner-a' })
    expect(mock.chatgpt).not.toHaveBeenCalled()
    expect(mock.launch).not.toHaveBeenCalled()
  })
  it('returns the already durable review result without reapplying a repeated operation', async () => {
    const saved = { ok: true, issues: [{ id: 'another-issue' }] }
    mock.accept.mockResolvedValue({ state: 'delivered', result: saved })
    const response = await request(launchReview)
    expect(response.status).toBe(200); expect(await response.json()).toEqual(saved)
    expect(mock.claim).not.toHaveBeenCalled()
    expect(mock.launch).not.toHaveBeenCalled()
    expect(mock.settle).not.toHaveBeenCalled()
    expect(mock.notify).not.toHaveBeenCalled()
  })
  it('retains a failed review for the same operation to be inspected instead of acknowledging success', async () => {
    mock.native.mockRejectedValue(new Error('receipt changed'))
    const response = await request({ ...launchReview, id: 'native-one', scope: 'project-one', kind: 'conversation', conversationId: 'native-session' })
    expect(response.status).toBe(409)
    expect(mock.settle).not.toHaveBeenCalled()
    expect(mock.notify).not.toHaveBeenCalled()
  })
  it('does not review a still-running tool or input effect', async () => {
    mock.read.mockResolvedValue({ execution: { sessionId: 'active-session' }, body: { kind: 'runtime-tool', sessionId: 'old-session' } })
    mock.occupied.mockReturnValue(true)
    expect((await request({ ...launchReview, id: 'input-one', scope: 'project-one', kind: 'tool' })).status).toBe(409)
    expect(mock.occupied).toHaveBeenCalledWith('active-session')
    expect(mock.read).toHaveBeenCalledWith('project-one', 'input-one', 'owner-a')
    expect(mock.review).not.toHaveBeenCalled()
    expect(mock.settle).not.toHaveBeenCalled()
  })
  it('rejects empty review notes before accepting or dispatching an operation', async () => {
    expect((await request({ ...launchReview, note: '  ' })).status).toBe(400)
    expect(mock.accept).not.toHaveBeenCalled()
    expect(mock.launch).not.toHaveBeenCalled()
  })
  it('refuses foreign origins, local-unlock-only users and stale renderer owners before reading recovery data', async () => {
    expect((await request(launchReview, { origin: 'https://foreign.example' })).status).toBe(403)
    mock.eligible = false
    expect((await request(launchReview)).status).toBe(403)
    mock.eligible = true
    expect((await request(launchReview, { 'X-OpenGround-Owner': 'renderer-owner-before' })).status).toBe(403)
    expect(mock.accept).not.toHaveBeenCalled()
    expect(mock.launch).not.toHaveBeenCalled()
    expect(mock.issues).not.toHaveBeenCalled()
  })
  it('passes the captured owner to a review after an asynchronous account change and fails closed', async () => {
    mock.accept.mockImplementation(async () => { mock.owner = 'owner-b'; return { state: 'queued' } })
    const response = await request(launchReview)
    expect(response.status).toBe(409)
    expect(mock.launch).toHaveBeenCalledWith({ id: 'launch-one', note: launchReview.note, expectedOwnerKey: 'owner-a' })
    expect(mock.settle).not.toHaveBeenCalled()
    expect(mock.notify).not.toHaveBeenCalled()
  })
  it('pins recovery listing to the request owner', async () => {
    mock.issues.mockResolvedValue([{ id: 'native-one', scope: 'project-one', kind: 'conversation', state: 'uncertain' }])
    const response = await conversationRoutes.request('/api/conversation/recovery', { headers: { 'X-OpenGround-Owner': 'renderer-owner-a' } })
    expect(response.status).toBe(200)
    expect(mock.issues).toHaveBeenCalledExactlyOnceWith('owner-a')
    expect(await response.json()).toEqual({ issues: [{ id: 'native-one', scope: 'project-one', kind: 'conversation', state: 'uncertain' }] })
  })
})

// Review R3-ui S1 / R4 S2 (2026-11-28): a held ChatGPT desk conversation always named
// the Settings recovery panel — which lists ChatGPT items only while the owner is
// signed in to the app, ChatGPT is live-connected to the account that started them,
// and work mode is off. The boot hold must pick its words from those facts
// (chatGptHoldHint), not name a panel that is empty.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Account = 'this' | 'other' | 'signed-out' | 'unreadable'
const BASE = { account: 'this' as Account, recovery: 'uncertain' as 'uncertain' | 'invalid', workMode: false, owner: 'owner-key' as string | null, connection: 'connected' }
const state = vi.hoisted(() => ({ ...{ account: 'this', recovery: 'uncertain', workMode: false, owner: 'owner-key' as string | null, connection: 'connected' } }))

vi.mock('./chatgptResponses', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./chatgptResponses')>()),
  chatGptConversationRecovery: async () => state.recovery,
  chatGptHistoryAccount: async () => state.account,
}))
vi.mock('./chatgptAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./chatgptAuth')>()),
  getChatGptConnection: async () => ({ state: state.connection, models: [] }),
}))
vi.mock('./runtimeOwner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runtimeOwner')>()),
  runtimeOwnerKey: async () => { if (state.owner === null) throw new Error('sign-in is required'); return state.owner },
}))
vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  getSettings: async () => ({ swarmProvider: 'chatgpt', lockdownMode: state.workMode, projects: [] }),
  isSwarmManualStopPersisted: async () => false,
}))
vi.mock('./swarmEnginePersistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmEnginePersistence')>()),
  readEngineIntent: async () => ({ supplyDesired: true, managerDesired: false }),
}))
vi.mock('./swarmSessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmSessions')>()),
  readSwarmSessions: async () => ({ chatgpt: { supply: { sessionId: 'chatgpt-held', cwd: '/proj' } } }),
}))
vi.mock('./runtimeActionReceipts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runtimeActionReceipts')>()),
  listUncertainRuntimeActions: async () => [],
}))
vi.mock('./savedWorkHold', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./savedWorkHold')>()),
  savedWorkHolds: async () => [],
}))

import { savedSwarmRuntimeHold } from './swarmRuntimeTransition'
import { CHATGPT_REVIEW_HOLD_HINT, CHATGPT_SIGN_IN_HOLD_HINT, CHATGPT_UNREADABLE_HOLD_HINT } from './savedWorkHold'

describe('a held ChatGPT president conversation at boot', () => {
  beforeEach(() => { Object.assign(state, BASE) })

  it('names the Settings panel while that panel can list it', async () => {
    expect(await savedSwarmRuntimeHold('/proj', 'supply')).toContain(CHATGPT_REVIEW_HOLD_HINT)
  })
  it.each([
    ['the history is another account\'s', { account: 'other', recovery: 'invalid' }],
    ['ChatGPT is signed out', { account: 'signed-out' }],
    ['work mode is on', { workMode: true }],
    ['the ChatGPT token expired (credentials stored, connection not live)', { connection: 'error' }],
    // (runtimeOwnerKey also throws without the owner role — one case covers both)
    ['the owner is not signed in to the app', { owner: null }],
  ] as const)('names the conditions instead when %s', async (_what, over) => {
    Object.assign(state, over)
    const reason = await savedSwarmRuntimeHold('/proj', 'supply')
    expect(reason).toContain(CHATGPT_SIGN_IN_HOLD_HINT)
    expect(reason).not.toContain(CHATGPT_REVIEW_HOLD_HINT)
  })
  it('promises no door for a history it cannot read', async () => {
    Object.assign(state, { account: 'unreadable', recovery: 'invalid' })
    expect(await savedSwarmRuntimeHold('/proj', 'supply')).toContain(CHATGPT_UNREADABLE_HOLD_HINT)
  })
})

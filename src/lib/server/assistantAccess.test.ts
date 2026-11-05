import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomTabRole } from '../types'

const state = vi.hoisted(() => ({ role: 'none' as CustomTabRole, localUnlock: false }))
const role = vi.hoisted(() => vi.fn(async () => state.role))
vi.mock('./roles', () => ({ getCustomTabRole: role }))
vi.mock('./swarmGate', () => ({ isSwarmLocalOwnerUnlocked: async () => state.localUnlock }))

import { canUseAssistant, hasAssistantAccess } from './assistantAccess'
import { hasChatGptAccess } from './chatgptAccess'

beforeEach(() => { state.role = 'none'; state.localUnlock = false; role.mockClear() })

describe('existing local assistant access', () => {
  it.each(['none', 'tester', 'owner'] as const)('keeps %s access identical between pure metadata and the live route gate', async (actualRole) => {
    for (const localUnlock of [false, true]) {
      state.role = actualRole
      state.localUnlock = localUnlock
      expect(canUseAssistant(actualRole, localUnlock)).toBe(actualRole === 'owner' || localUnlock)
      expect(await hasAssistantAccess()).toBe(canUseAssistant(actualRole, localUnlock))
    }
  })

  it('keeps the explicit local unlock usable without a role lookup', async () => {
    state.localUnlock = true
    expect(await hasAssistantAccess()).toBe(true)
    expect(role).not.toHaveBeenCalled()
  })

  it('never promotes the local assistant permission into ChatGPT provider access', async () => {
    state.localUnlock = true
    expect(await hasAssistantAccess()).toBe(true)
    expect(await hasChatGptAccess()).toBe(false)
    state.role = 'owner'
    expect(await hasChatGptAccess()).toBe(true)
  })
})
